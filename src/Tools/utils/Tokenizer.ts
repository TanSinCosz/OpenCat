export interface Tokenizer {
    encode(text: string): number[] | { length: number }
}
