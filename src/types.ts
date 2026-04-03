export interface PdfReviewSource {
  kind: "file" | "url";
  input: string;
  displayName: string;
  title: string;
  bytesBase64: string;
  byteLength: number;
}

export interface PdfReviewBootData {
  source: PdfReviewSource;
  maxComments: number;
}

export interface PdfSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfAnnotationComment {
  id: string;
  pageNumber: number;
  quote: string;
  comment: string;
  rects: PdfSelectionRect[];
  createdAt: number;
  sent?: boolean;
}

export interface PdfReviewAskPayload {
  type: "ask";
  comments: PdfAnnotationComment[];
  totalSent: number;
}

export interface PdfReviewCancelPayload {
  type: "cancel";
}

export type PdfReviewWindowMessage = PdfReviewAskPayload | PdfReviewCancelPayload;
