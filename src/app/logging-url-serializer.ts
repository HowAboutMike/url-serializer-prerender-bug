import { DefaultUrlSerializer, UrlSerializer, UrlTree } from '@angular/router';

export class LoggingUrlSerializer implements UrlSerializer {
  private readonly inner = new DefaultUrlSerializer();

  parse(url: string): UrlTree {
    console.log('[LoggingUrlSerializer] parse() called with:', url);
    return this.inner.parse(url);
  }

  serialize(tree: UrlTree): string {
    const out = this.inner.serialize(tree);
    console.log('[LoggingUrlSerializer] serialize() called ->', out);
    return out;
  }
}
