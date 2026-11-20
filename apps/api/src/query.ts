import { z } from 'zod';

/**
 * Query-string boolean.
 *
 * `z.coerce.boolean()` is wrong for query parameters: it uses JavaScript
 * truthiness, so the string "false" coerces to `true`. Every `?flag=false`
 * would therefore enable the flag.
 *
 * This accepts the forms a browser actually sends and rejects anything else.
 */
export const queryBoolean = (defaultValue = false) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .default(defaultValue)
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'));
