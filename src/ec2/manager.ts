/**
 * EC2 instance management for the lease system.
 * Mirrors the Go implementation at mmp-compute/lambda-proxy/internal/ec2/manager.go
 *
 * Provides methods to launch, describe, terminate EC2 instances and manage
 * per-lease security groups with SSH ingress rules.
 */

import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DeleteSecurityGroupCommand,
  type _InstanceType,
  type IpPermission,
  type IpRange,
  type Tag,
  type TagSpecification,
  type InstanceNetworkInterfaceSpecification,
  type InstanceMetadataOptionsRequest,
  type BlockDeviceMapping,
  type EbsBlockDevice,
} from '@aws-sdk/client-ec2';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates SSH usernames to prevent shell injection in user-data scripts. */
const SAFE_USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateSSHUser(user: string): void {
  if (user === '') {
    throw new Error('SSH user cannot be empty');
  }
  if (user.length > 32) {
    throw new Error('SSH user too long (max 32 characters)');
  }
  if (!SAFE_USERNAME_PATTERN.test(user)) {
    throw new Error(
      'SSH user contains invalid characters (only alphanumeric, hyphens, underscores allowed)',
    );
  }
}

function validateSSHPublicKey(key: string): void {
  if (key === '') {
    throw new Error('SSH public key cannot be empty');
  }
  if (key.includes("'") || key.includes('\n') || key.includes('\r')) {
    throw new Error(
      'SSH public key contains invalid characters (single quotes or newlines)',
    );
  }
}

// ---------------------------------------------------------------------------
// Cloud-init user-data
// ---------------------------------------------------------------------------

/**
 * Generates a base64-encoded cloud-init user-data script that injects
 * the SSH public key for the specified user.
 */
function userDataScript(sshPublicKey: string, sshUser: string): string {
  validateSSHUser(sshUser);
  validateSSHPublicKey(sshPublicKey);

  const trimmedKey = sshPublicKey.trim();

  const script = `#!/bin/bash
set -euo pipefail

# Ensure .ssh directory exists for the target user
SSH_DIR="/home/${sshUser}/.ssh"
mkdir -p "$SSH_DIR"

# Append the public key to authorized_keys
echo '${trimmedKey}' >> "$SSH_DIR/authorized_keys"

# Fix permissions
chmod 700 "$SSH_DIR"
chmod 600 "$SSH_DIR/authorized_keys"
chown -R ${sshUser}:${sshUser} "$SSH_DIR"
`;

  return Buffer.from(script, 'utf-8').toString('base64');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EC2ManagerConfig {
  region: string;
  subnetIds: string[];
  securityGroupId: string;
  vpcId: string;
}

export interface LaunchParams {
  leaseId: string;
  resourceId: string;
  payerAddress: string;
  amiId: string;
  instanceType: string;
  sshPublicKey: string;
  sshUser: string;
  subnetId: string;
  securityGroupId: string;
  volumeSize: number;
  associatePublicIp: boolean;
  expiresAt: string;
}

export interface InstanceInfo {
  instanceId: string;
  publicIp: string;
  /** "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated" */
  state: string;
}

export interface SecurityGroupParams {
  vpcId: string;
  leaseId: string;
  sshCidrs?: string[];
}

// ---------------------------------------------------------------------------
// EC2Manager
// ---------------------------------------------------------------------------

export class EC2Manager {
  private readonly client: EC2Client;

  constructor(config: EC2ManagerConfig) {
    this.client = new EC2Client({ region: config.region });
  }

  /**
   * Launches a new EC2 instance with the given parameters.
   *
   * Creates a cloud-init user-data script that injects the SSH public key,
   * configures the network interface with the specified subnet and security group,
   * requires IMDSv2, and uses gp3 encrypted EBS volumes.
   */
  async launchInstance(params: LaunchParams): Promise<InstanceInfo> {
    const userData = userDataScript(params.sshPublicKey, params.sshUser);

    // Build network interface specification
    const networkInterface: InstanceNetworkInterfaceSpecification = {
      DeviceIndex: 0,
      SubnetId: params.subnetId,
      Groups: [params.securityGroupId],
      AssociatePublicIpAddress: params.associatePublicIp,
    };

    // Require IMDSv2 to prevent SSRF-based credential theft via IMDSv1
    const metadataOptions: InstanceMetadataOptionsRequest = {
      HttpTokens: 'required',
      HttpEndpoint: 'enabled',
    };

    // Build tags
    const tags: Tag[] = [
      { Key: 'Name', Value: `lease-${params.leaseId}` },
      { Key: 'lease-id', Value: params.leaseId },
      { Key: 'resource-id', Value: params.resourceId },
      { Key: 'payer-address', Value: params.payerAddress },
      { Key: 'expires-at', Value: params.expiresAt },
      { Key: 'ManagedBy', Value: 'mmp-aws' },
    ];

    const tagSpecifications: TagSpecification[] = [
      {
        ResourceType: 'instance',
        Tags: tags,
      },
    ];

    // Always specify block device mapping to ensure EBS encryption at rest.
    // When volumeSize > 0, use the requested size; otherwise omit VolumeSize
    // to use the AMI default.
    const ebs: EbsBlockDevice = {
      VolumeType: 'gp3',
      Encrypted: true,
    };
    if (params.volumeSize > 0) {
      ebs.VolumeSize = params.volumeSize;
    }

    const blockDeviceMappings: BlockDeviceMapping[] = [
      {
        DeviceName: '/dev/sda1',
        Ebs: ebs,
      },
    ];

    const command = new RunInstancesCommand({
      ImageId: params.amiId,
      InstanceType: params.instanceType as _InstanceType,
      MinCount: 1,
      MaxCount: 1,
      UserData: userData,
      NetworkInterfaces: [networkInterface],
      MetadataOptions: metadataOptions,
      TagSpecifications: tagSpecifications,
      BlockDeviceMappings: blockDeviceMappings,
    });

    const result = await this.client.send(command);

    if (!result.Instances || result.Instances.length === 0) {
      throw new Error('no instances returned from RunInstances');
    }

    const instance = result.Instances[0];

    return {
      instanceId: instance.InstanceId ?? '',
      publicIp: instance.PublicIpAddress ?? '',
      state: instance.State?.Name ?? 'unknown',
    };
  }

  /**
   * Terminates an EC2 instance by ID.
   */
  async terminateInstance(instanceId: string): Promise<void> {
    const command = new TerminateInstancesCommand({
      InstanceIds: [instanceId],
    });

    await this.client.send(command);
  }

  /**
   * Returns the current state of an EC2 instance, or null if not found.
   */
  async describeInstance(instanceId: string): Promise<InstanceInfo> {
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    });

    const result = await this.client.send(command);

    if (
      result.Reservations &&
      result.Reservations.length > 0 &&
      result.Reservations[0].Instances &&
      result.Reservations[0].Instances.length > 0
    ) {
      const instance = result.Reservations[0].Instances[0];
      return {
        instanceId: instance.InstanceId ?? '',
        publicIp: instance.PublicIpAddress ?? '',
        state: instance.State?.Name ?? 'unknown',
      };
    }

    throw new Error(`instance ${instanceId} not found`);
  }

  /**
   * Creates a dedicated security group for a lease with SSH (port 22) ingress rules.
   *
   * The security group is named "lease-{leaseId}" and tagged with lease metadata.
   * If sshCidrs is empty, defaults to ["0.0.0.0/0"].
   *
   * If adding the ingress rule fails, the security group is cleaned up automatically.
   *
   * @returns The security group ID (sg-...)
   */
  async createSecurityGroup(
    params: SecurityGroupParams,
  ): Promise<string> {
    const { leaseId, sshCidrs, vpcId } = params;
    const groupName = `lease-${leaseId}`;

    // Create the security group
    const createCommand = new CreateSecurityGroupCommand({
      GroupName: groupName,
      Description: `Per-lease security group for lease ${leaseId}`,
      VpcId: vpcId,
      TagSpecifications: [
        {
          ResourceType: 'security-group',
          Tags: [
            { Key: 'lease-id', Value: leaseId },
            { Key: 'ManagedBy', Value: 'mmp-aws' },
            { Key: 'Name', Value: groupName },
          ],
        },
      ],
    });

    const createResult = await this.client.send(createCommand);
    const sgId = createResult.GroupId ?? '';

    if (sgId === '') {
      throw new Error(`failed to create security group for lease ${leaseId}: no group ID returned`);
    }

    // Add SSH ingress rule
    const cidrs = sshCidrs && sshCidrs.length > 0 ? sshCidrs : ['0.0.0.0/0'];

    const ipRanges: IpRange[] = cidrs.map((cidr) => ({
      CidrIp: cidr,
      Description: `SSH access for lease ${leaseId}`,
    }));

    const ipPermissions: IpPermission[] = [
      {
        IpProtocol: 'tcp',
        FromPort: 22,
        ToPort: 22,
        IpRanges: ipRanges,
      },
    ];

    const ingressCommand = new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: ipPermissions,
    });

    try {
      await this.client.send(ingressCommand);
    } catch (ingressErr: unknown) {
      // Attempt to clean up the security group if the ingress rule fails
      try {
        await this.client.send(
          new DeleteSecurityGroupCommand({ GroupId: sgId }),
        );
      } catch {
        // Best-effort cleanup; ignore errors
      }
      throw new Error(
        `failed to authorize SSH ingress for security group ${sgId}: ${ingressErr instanceof Error ? ingressErr.message : String(ingressErr)}`,
      );
    }

    return sgId;
  }

  /**
   * Deletes a security group by ID.
   *
   * Returns without error if the security group is already deleted (InvalidGroup.NotFound).
   * Throws a descriptive error on DependencyViolation (SG still attached to a running instance).
   */
  async deleteSecurityGroup(sgId: string): Promise<void> {
    const command = new DeleteSecurityGroupCommand({
      GroupId: sgId,
    });

    try {
      await this.client.send(command);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // Already deleted — treat as success
      if (message.includes('InvalidGroup.NotFound')) {
        return;
      }

      // Still in use — provide a descriptive error
      if (message.includes('DependencyViolation')) {
        throw new Error(
          `security group ${sgId} still in use (DependencyViolation): ${message}`,
        );
      }

      throw new Error(`failed to delete security group ${sgId}: ${message}`);
    }
  }
}
