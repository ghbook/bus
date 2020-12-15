import { ClassConstructor } from '../util'
import { JsonSerializer } from './json-serializer'

let configuredSerializer: Serializer | undefined
const defaultSerializer = new JsonSerializer()

export const getSerializer = () => configuredSerializer || defaultSerializer
export const setSerializer = (serializer: Serializer) => {
  configuredSerializer = serializer
}

export interface Serializer {
  serialize<T extends object> (obj: T): string
  deserialize<T extends object> (val: string, classType: ClassConstructor<T>): T
  toPlain<T extends object> (obj: T): object
  toClass<T extends object> (obj: object, classConstructor: ClassConstructor<T>): T
}
