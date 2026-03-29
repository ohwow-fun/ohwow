/**
 * Type declarations for optional peer dependencies.
 * These packages are dynamically imported at runtime only when hardware
 * features are used. They don't need to be installed for the core runtime.
 */

declare module 'serialport' {
  export class SerialPort {
    constructor(options: { path: string; baudRate: number; autoOpen?: boolean });
    pipe<T>(parser: T): T;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, callback: (...args: any[]) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    once(event: string, callback: (...args: any[]) => void): void;
    open(callback: (err: Error | null) => void): void;
    write(data: string | Buffer, callback?: (err: Error | null) => void): void;
    close(callback?: () => void): void;
    isOpen: boolean;
  }
}

declare module '@serialport/parser-readline' {
  export class ReadlineParser {
    constructor(options: { delimiter: string });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, callback: (...args: any[]) => void): void;
  }
}

declare module 'mqtt' {
  export interface IClientOptions {
    clientId?: string;
    username?: string;
    password?: string;
    reconnectPeriod?: number;
    connectTimeout?: number;
  }

  export interface MqttClient {
    connected: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, callback: (...args: any[]) => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    once(event: string, callback: (...args: any[]) => void): void;
    subscribe(topic: string, callback?: (err: Error | null) => void): void;
    publish(topic: string, message: string, options?: { qos?: number }, callback?: (err?: Error | null) => void): void;
    end(force?: boolean, callback?: () => void): void;
  }

  export function connect(url: string, options?: IClientOptions): MqttClient;
}
