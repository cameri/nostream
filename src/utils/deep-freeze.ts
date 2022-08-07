export const deepFreeze = (obj) => {
  Object.getOwnPropertyNames(obj)
    .filter((prop) => obj[prop] && typeof obj[prop] === 'object')
    .forEach(deepFreeze)
  Object.freeze(obj)
}
