// The level pictures: flat stained-glass art from ./assets/levels (see
// levelArt.ts). Each colour in a picture's palette is one class — its crabs
// and boxes wear that colour. Every picture is PIC_W × PIC_H.

import { LEVEL_ART } from './levelArt';

export const PIC_W = 596;
export const PIC_H = 596;

export interface PictureClass {
  /** Colour of the tiles and ants for this class. */
  color: string;
  /** Picture colours that belong to the class (classification anchors). */
  anchors: [number, number, number][];
}

export interface Picture {
  classes: PictureClass[];
  /** Paints the picture onto a PIC_W × PIC_H context. */
  draw(ctx: CanvasRenderingContext2D): void;
  /** Panes are flat colours (default). False for art with shaded panes: colours are read per pixel. */
  panes?: boolean;
}

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];

const images: HTMLImageElement[] = [];
export function loadPictures(): Promise<void> {
  return Promise.all(LEVEL_ART.map((art, i) => new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => { images[i] = img; resolve(); };
    img.onerror = () => resolve();
    img.src = art.url;
  }))).then(() => undefined);
}

export const PICTURES: Picture[] = LEVEL_ART.map((art, i) => ({
  classes: art.palette.map((hex) => ({ color: hex, anchors: [rgb(hex)] })),
  draw(ctx) {
    if (images[i]) ctx.drawImage(images[i], 0, 0, PIC_W, PIC_H);
  },
}));
