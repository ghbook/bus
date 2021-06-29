/**
 * This is the same logger definition as in @node-ts/logger-core. It's added
 * here for brevity so that @node-ts/logger-core doesn't need to be imported
 * whilst it still has the hard dependency on inversify.
 *
 * Because it's the same shape, duck typing should allow this to be used
 * interchangeably with other packages that consume @node-ts/logger-core
 */
export interface Logger {
  debug (message: string, meta?: object): void
  trace (message: string, meta?: object): void
  info (message: string, meta?: object): void
  warn (message: string, meta?: object): void
  error (message: string, meta?: object): void
  fatal (message: string, meta?: object): void
}

