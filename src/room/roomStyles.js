export const ROOM_STYLES = Object.freeze({
  light: {
    background: '#e4e9ee', wall: '#f3f5f7', ceiling: '#dce3e9',
    floorBack: '#cbd4dd', floorFront: '#adb9c5', grid: '#526579',
    speaker: '#727981', speakerPanel: '#505963', driver: '#939ca6', title: '#24374b',
  },
  dark: {
    background: '#151b22', wall: '#414b57', ceiling: '#303b47',
    floorBack: '#303b49', floorFront: '#1b2634', grid: '#718397',
    speaker: '#e2e7ec', speakerPanel: '#a7b2bd', driver: '#596774', title: '#f1f6fb',
  },
  traditional: {
    background: '#8bbfd7', wall: '#a7d9ee', ceiling: '#91c5de',
    floorBack: '#507bb0', floorFront: '#234b86', grid: '#e4f1fc',
    speaker: '#566773', speakerPanel: '#344751', driver: '#8397a4', title: '#183e62',
  },
})

export function roomStyle(value) {
  return ROOM_STYLES[value] ?? ROOM_STYLES.light
}
