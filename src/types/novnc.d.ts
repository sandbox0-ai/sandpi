declare module "@novnc/novnc/lib/rfb" {
  interface RfbOptions {
    shared?: boolean;
  }

  interface RfbEvents {
    connect: CustomEvent<Record<string, never>>;
    disconnect: CustomEvent<{ clean: boolean }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
  }

  export default class Rfb extends EventTarget {
    constructor(target: Element, url: string, options?: RfbOptions);

    viewOnly: boolean;
    focusOnClick: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    qualityLevel: number;
    compressionLevel: number;

    addEventListener<T extends keyof RfbEvents>(
      type: T,
      listener: (event: RfbEvents[T]) => void,
    ): void;
    removeEventListener<T extends keyof RfbEvents>(
      type: T,
      listener: (event: RfbEvents[T]) => void,
    ): void;
    disconnect(): void;
  }
}
