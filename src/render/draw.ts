import type { ImageFraming } from '../domain/types';

export interface SceneFrame {
  bitmap: ImageBitmap;
  framing: ImageFraming;
  text: string;
}

const BACKGROUND = '#07080c';
const TEXT_FONT_FAMILY =
  '"Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

/**
 * Draw one silent storyboard frame: the image framed to 9:16, then the scene's
 * on-screen text over a legibility scrim.
 */
export function drawSceneFrame(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: SceneFrame,
  width: number,
  height: number,
): void {
  context.save();
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);

  const { bitmap } = frame;
  const scale =
    frame.framing === 'fill'
      ? Math.max(width / bitmap.width, height / bitmap.height)
      : Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    bitmap,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );

  if (frame.text.trim() !== '') drawCaption(context, frame.text, width, height);
  context.restore();
}

function drawCaption(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  width: number,
  height: number,
): void {
  const padding = 64;
  const maxWidth = width - padding * 2;
  const fontSize = 54;
  const lineHeight = Math.round(fontSize * 1.25);
  context.font = `700 ${fontSize}px ${TEXT_FONT_FAMILY}`;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';

  const lines = wrapText(context, text, maxWidth, 4);
  const blockHeight = lines.length * lineHeight;
  const bottom = height - 120;
  const top = bottom - blockHeight;

  const scrimTop = Math.max(0, top - 70);
  const gradient = context.createLinearGradient(0, scrimTop, 0, height);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(0.55, 'rgba(0, 0, 0, 0.62)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0.86)');
  context.fillStyle = gradient;
  context.fillRect(0, scrimTop, width, height - scrimTop);

  context.fillStyle = '#ffffff';
  context.shadowColor = 'rgba(0, 0, 0, 0.7)';
  context.shadowBlur = 10;
  context.shadowOffsetY = 2;
  lines.forEach((line, index) => {
    context.fillText(line, width / 2, top + lineHeight * (index + 1) - 8);
  });
  context.shadowBlur = 0;
  context.shadowOffsetY = 0;
}

function wrapText(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const pieces = context.measureText(word).width > maxWidth ? splitWord(word, maxWidth, context) : [word];
      for (const piece of pieces) {
        const candidate = current === '' ? piece : `${current} ${piece}`;
        if (context.measureText(candidate).width <= maxWidth) {
          current = candidate;
        } else {
          if (current !== '') lines.push(current);
          current = piece;
        }
      }
    }
    if (current !== '') lines.push(current);
  }

  const nonEmpty = lines.filter((line) => line !== '');
  if (nonEmpty.length > maxLines) {
    const clipped = nonEmpty.slice(0, maxLines);
    clipped[maxLines - 1] = `${clipped[maxLines - 1]}…`;
    return clipped;
  }
  return nonEmpty;
}

function splitWord(
  word: string,
  maxWidth: number,
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const character of word) {
    const candidate = current + character;
    if (current !== '' && context.measureText(candidate).width > maxWidth) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current !== '') pieces.push(current);
  return pieces;
}
