export const W = 1920
export const H = 1080
export const FPS = 30
export const DURATION = 1020

/** omp.sh palette: near-black, graded whites, teal labels, hot pink accent */
export const BG = '#08080a'
export const FG = '#f7f7f7'
export const FG_2 = '#a8a8a8'
export const BODY = '#b0b0b0'
export const MUTED = '#808080'
export const TEAL = '#86b3ae'
export const PINK = '#ff2e88'
export const PINK_DIM = '#6a1a3f'
export const LINE = '#26262a'
export const WIRE = '#48484f'
export const PANEL = '#0e0e11'
export const PANEL_BORDER = '#2e2e33'

export const FONT_MONO = 'JetBrainsMono'
export const FONT_SANS = 'Inter'

/** JetBrains Mono advance width is 600/1000 em */
export const monoWidth = (text: string, size: number, spacing = 0) => text.length * (size * 0.6 + spacing)
