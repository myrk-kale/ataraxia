declare module "jsdom" {
  /** The little of jsdom the tests use; the package ships no types. */
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window: any;
  }
}
