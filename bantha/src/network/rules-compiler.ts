import { LoadedSandboxConfig, NetworkEgressRule, ServiceDefinition } from '../config/loader';

export interface CompiledNetworkPlan {
  mode: 'hermetic' | 'none' | 'host';
  defaultPolicy: string;
  services?: ServiceDefinition[];
  dns: {
    enabled: boolean;
    upstreamServers: string[];
    allowedDomains: string[];
    deniedDomains: string[];
    blockPlainUdpDns: boolean;
  };
  sntp: {
    enabled: boolean;
    blockAll: boolean;
  };
  egressRules: {
    proto: 'tcp' | 'udp';
    ips?: string[];
    ports?: number[];
    domains?: string[];
  }[];
  ingressRules: {
    proto: 'tcp' | 'udp';
    ips?: string[];
    ports?: number[];
  }[];
}

export class NetworkRulesCompiler {
  private config: LoadedSandboxConfig;

  constructor(config: LoadedSandboxConfig) {
    this.config = config;
  }

  public compile(): CompiledNetworkPlan {
    const net = this.config.network;
    const allowedDomains: string[] = [];
    const deniedDomains: string[] = [];

    for (const rule of net.dns?.rules || []) {
      const trimmed = rule.trim();
      if (trimmed.startsWith('!')) {
        deniedDomains.push(trimmed.slice(1).trim());
      } else {
        allowedDomains.push(trimmed);
      }
    }

    const egressRules: CompiledNetworkPlan['egressRules'] = [];
    for (const r of net.egress?.rules || []) {
      if (typeof r === 'object') {
        const item: CompiledNetworkPlan['egressRules'][0] = {
          proto: r.proto || 'tcp'
        };
        if (r.ips) item.ips = r.ips;
        if (r.port) item.ports = [r.port];
        if (r.ports) item.ports = r.ports;
        if (r.domains) item.domains = r.domains;
        egressRules.push(item);
      }
    }

    const ingressRules: CompiledNetworkPlan['ingressRules'] = [];
    for (const r of net.ingress?.rules || []) {
      if (typeof r === 'object') {
        ingressRules.push({
          proto: r.proto || 'tcp',
          ips: r.ips,
          ports: r.ports || (r.port ? [r.port] : undefined)
        });
      }
    }

    return {
      mode: net.mode || 'hermetic',
      defaultPolicy: net.default_policy || 'DROP',
      services: net.services || [],
      dns: {
        enabled: net.dns?.enabled ?? true,
        upstreamServers: net.dns?.upstream_servers || ['1.1.1.1', '8.8.8.8'],
        allowedDomains,
        deniedDomains,
        blockPlainUdpDns: net.dns?.block_plain_udp_dns ?? true
      },
      sntp: {
        enabled: net.sntp?.enabled ?? false,
        blockAll: !(net.sntp?.enabled ?? false)
      },
      egressRules,
      ingressRules
    };
  }
}
