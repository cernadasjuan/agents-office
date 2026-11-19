/** Canvas text helpers shared by the wall boards and the issue cards. */

type Context = CanvasRenderingContext2D;

export function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

export function textWidth(ctx: Context, text: string): number {
  const width = ctx.measureText?.(text)?.width;
  return typeof width === 'number' ? width : text.length * 10;
}

export function fitted(ctx: Context, text: string, maxWidth: number): string {
  if (textWidth(ctx, text) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(ctx, `${cut}…`) > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}
