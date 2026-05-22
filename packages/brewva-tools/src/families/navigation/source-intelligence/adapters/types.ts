import type { SourceDocument, SourceLanguage } from "../ir.js";

export interface SourceParseInput {
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly sourceText: string;
  readonly sourceHash: string;
}

export interface SourceParserAdapter {
  readonly language: SourceLanguage;
  readonly parserVersion: string;
  readonly grammarVersion: string;
  parse(input: SourceParseInput): SourceDocument | Promise<SourceDocument>;
}
