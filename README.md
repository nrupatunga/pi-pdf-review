# pi-pdf-review

Native PDF review window for Pi using Glimpse.

## What it does

- Opens a local PDF file or URL in a native review window
- Renders pages with PDF.js
- Lets you select text and attach comments/questions
- Sends a structured summary back into Pi

## Install

```bash
pi install /absolute/path/to/pi-pdf-review
```

Or from the project directory:

```bash
pi install ./pi-pdf-review
```

Restart Pi after installing.

## Usage

```bash
/pdf-review ./paper.pdf
/pdf-review ~/Documents/spec.pdf
/pdf-review https://example.com/paper.pdf
```

### Flow

1. Open the PDF with `/pdf-review`
2. Select text in the native window
3. Click **Comment selection**
4. Add your question or note
5. Click **Insert into Pi**
6. Pi pre-fills the editor with a structured summary you can send or edit

## Notes

- This first cut loads PDF.js from a CDN inside the native window.
- Very large PDFs are currently capped to keep the payload manageable.
- The MVP focuses on text-selection comments rather than freehand drawing.
