import type { z } from "zod";

export type MaybePromise<T> = T | Promise<T>;

export type ToolExecutionValue =
  | string
  | number
  | boolean
  | null
  | ToolExecutionObject
  | ToolExecutionValue[];

export interface ToolExecutionObject {
  [key: string]: ToolExecutionValue;
}

export type ToolInputSchema = z.ZodType | (() => z.ZodType);

export interface Tool<
  TInput = Record<string, unknown>,
  TOutput = ToolExecutionValue,
> {
  name: string;
  input_schema: ToolInputSchema;
  max_result_size_chars?: number;
  search_hint?: string;
  should_defer?: boolean;
  always_load?: boolean;
  strict?: boolean;
  description(): string;
  prompt?(): string;
  is_enabled?(): MaybePromise<boolean>;
  user_facing_name?(): string;
  is_concurrency_safe?(): boolean;
  call(
    input: TInput,
  ): MaybePromise<TOutput>;
}

export type JSONSchema =
  | JSONSchemaString
  | JSONSchemaNumber
  | JSONSchemaBoolean
  | JSONSchemaNull
  | JSONSchemaObject
  | JSONSchemaArray;

export interface JSONSchemaBase {
  description?: string;
}

export interface JSONSchemaString extends JSONSchemaBase {
  type: "string";
  enum?: string[];
}

export interface JSONSchemaNumber extends JSONSchemaBase {
  type: "number" | "integer";
}

export interface JSONSchemaBoolean extends JSONSchemaBase {
  type: "boolean";
}

export interface JSONSchemaNull extends JSONSchemaBase {
  type: "null";
}

export interface JSONSchemaArray extends JSONSchemaBase {
  type: "array";
  items: JSONSchema;
}

export interface JSONSchemaObject extends JSONSchemaBase {
  type: "object";
  properties: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
}
