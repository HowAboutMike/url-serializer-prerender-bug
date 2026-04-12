import { DefaultUrlSerializer, UrlSerializer, UrlTree } from '@angular/router';

const LOCALE = 'en';
const LOCALE_PREFIX = `/${LOCALE}`;

/**
 * Pretends `/foo` to the user but stores `/en/foo` internally.
 * - parse(url): strips /en/ prefix before delegating to the default parser.
 *   The router thinks the URL is `/foo`, so routes match without a :locale param.
 * - serialize(tree): delegates to the default serializer, then prepends /en.
 *   The browser address bar sees `/en/foo`.
 *
 * This is the transparent-locale-prefix pattern that was reportedly broken
 * in Angular 21 (silent fail or redirect loop).
 */
export class LocalePrefixUrlSerializer implements UrlSerializer {
  private readonly inner = new DefaultUrlSerializer();

  parse(url: string): UrlTree {
    console.log('[LocalePrefixUrlSerializer] parse() input:', url);
    const stripped = this.stripLocale(url);
    console.log('[LocalePrefixUrlSerializer] parse() stripped:', stripped);
    return this.inner.parse(stripped);
  }

  serialize(tree: UrlTree): string {
    const inner = this.inner.serialize(tree);
    const out = inner === '/' ? LOCALE_PREFIX : `${LOCALE_PREFIX}${inner}`;
    console.log('[LocalePrefixUrlSerializer] serialize() inner:', inner, '-> out:', out);
    return out;
  }

  private stripLocale(url: string): string {
    if (url === LOCALE_PREFIX) return '/';
    if (url.startsWith(`${LOCALE_PREFIX}/`)) return url.slice(LOCALE_PREFIX.length);
    return url;
  }
}
