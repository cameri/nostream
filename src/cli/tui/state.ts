export type TuiState = {
  running: boolean
}

export const createState = (): TuiState => ({
  running: true,
})
