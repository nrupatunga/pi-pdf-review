declare module "glimpseui" {
  import { EventEmitter } from "node:events";

  export interface GlimpseOpenOptions {
    width?: number;
    height?: number;
    title?: string;
    x?: number;
    y?: number;
    frameless?: boolean;
    floating?: boolean;
    transparent?: boolean;
    clickThrough?: boolean;
    hidden?: boolean;
    autoClose?: boolean;
    timeout?: number;
  }

  export class GlimpseWindow extends EventEmitter {
    on(event: "ready", listener: () => void): this;
    on(event: "message", listener: (data: unknown) => void): this;
    on(event: "closed", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    once(event: "ready", listener: () => void): this;
    once(event: "message", listener: (data: unknown) => void): this;
    once(event: "closed", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    send(js: string): void;
    setHTML(html: string): void;
    show(options?: { title?: string }): void;
    close(): void;
    loadFile(path: string): void;
  }

  export function open(html: string, options?: GlimpseOpenOptions): GlimpseWindow;
}
