export interface TextSignatureV1 {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
}

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface FileContent {
  type: "file";
  uri: string;
  name?: string;
  mimeType?: string;
  displayText?: string;
}

export interface ResolvedTextFileContent {
  kind: "text";
  uri: string;
  text: string;
  name?: string;
  mimeType?: string;
}

export interface ResolvedImageFileContent {
  kind: "image";
  uri: string;
  data: string;
  mimeType: string;
  name?: string;
}

export interface ResolvedBinaryFileContent {
  kind: "binary";
  uri: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  summary?: string;
  dataBase64?: string;
}

export interface ResolvedDirectoryFileContent {
  kind: "directory";
  uri: string;
  name?: string;
  entries?: string[];
  summary?: string;
}

export type ResolvedFileContent =
  | ResolvedTextFileContent
  | ResolvedImageFileContent
  | ResolvedBinaryFileContent
  | ResolvedDirectoryFileContent;
