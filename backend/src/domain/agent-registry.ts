import { CapabilityUnavailableError, HttpError } from './errors.js';
import type { AiGatewayStreamEvent } from './ai-gateway.js';
import type { AgentExecutionContext, AgentResult, Capability } from './types.js';

export interface CapabilityDriver {
  readonly capability: Capability;
  isReady(): Promise<boolean>;
  execute(context: AgentExecutionContext): Promise<AgentResult>;
  stream?(context: AgentExecutionContext): AsyncIterable<AiGatewayStreamEvent>;
}

export interface ReadinessCheck {
  capability: Capability;
  ready: boolean;
}

/** Registry is the only extension point for real agent/model/tool drivers. */
export class AgentRegistry {
  private readonly drivers = new Map<Capability, CapabilityDriver>();

  register(driver: CapabilityDriver): void {
    if (this.drivers.has(driver.capability)) {
      throw new Error(`A driver is already registered for ${driver.capability}`);
    }
    this.drivers.set(driver.capability, driver);
  }

  registeredCount(): number {
    return this.drivers.size;
  }

  async readiness(capability: Capability): Promise<ReadinessCheck> {
    const driver = this.drivers.get(capability);
    if (!driver) return { capability, ready: false };
    try {
      return { capability, ready: await driver.isReady() };
    } catch {
      return { capability, ready: false };
    }
  }

  async requireReady(capability: Capability): Promise<CapabilityDriver> {
    const driver = this.drivers.get(capability);
    if (!driver || !(await this.readiness(capability)).ready) throw new CapabilityUnavailableError();
    return driver;
  }

  async execute(context: AgentExecutionContext): Promise<AgentResult> {
    const driver = await this.requireReady(context.capability);
    return driver.execute(context);
  }

  async stream(context: AgentExecutionContext): Promise<AsyncIterable<AiGatewayStreamEvent>> {
    const driver = await this.requireReady(context.capability);
    if (!driver.stream) throw new HttpError(501, 'CAPABILITY_STREAMING_UNAVAILABLE', 'Streaming is unavailable for this capability.');
    return driver.stream(context);
  }
}
