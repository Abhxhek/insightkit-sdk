import { z } from 'zod';

/** Tab, newline and carriage return are the only control characters this repo accepts anywhere. */
const ALLOWED = new Set([9, 10, 13]);

const hasControlCharacter = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code < 32 && !ALLOWED.has(code)) || (code >= 127 && code <= 159)) return true;
  }
  return false;
};

export const prose = (max: number): z.ZodType<string, string> =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !hasControlCharacter(text), { message: 'must not contain control characters' });
