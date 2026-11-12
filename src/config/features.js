// Availability is also checked against the server configuration. Provider
// credentials belong in Functions environment variables, never in this file.
export const AUDIO_FILE_ENABLED = true

// Thorough chains MVSEP jobs and is paused while MVSEP blocks chained inputs
// (server: SEPARATION_THOROUGH_ENABLED). While false, the upload panel shows a
// single six-stem option and a remembered Thorough choice is ignored.
export const THOROUGH_AVAILABLE = false
