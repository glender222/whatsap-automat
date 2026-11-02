/**
 * DocumentParser: Multi-format text extractor for RAG knowledge base ingestion.
 * Supports text, markdown, CSV, JSON, and PDF text extracts.
 */
export class DocumentParser {
  /**
   * Parses raw file content according to its declared format and returns normalized text.
   */
  static parse(content: string, fileType: 'text' | 'markdown' | 'pdf' | 'csv' | 'json' = 'text'): string {
    if (!content || typeof content !== 'string') {
      return '';
    }

    switch (fileType) {
      case 'csv':
        return this.parseCsv(content);
      case 'json':
        return this.parseJson(content);
      case 'markdown':
        return this.parseMarkdown(content);
      case 'pdf':
        return this.parsePdfText(content);
      case 'text':
      default:
        return this.normalizeText(content);
    }
  }

  /**
   * Normalizes raw text: standardizes newlines, trims, and cleans excess whitespace.
   */
  private static normalizeText(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Parses CSV rows into rich semantic prose for higher vector retrieval accuracy.
   */
  private static parseCsv(content: string): string {
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return '';

    const headerLine = lines[0];
    const headers = this.splitCsvLine(headerLine);
    if (headers.length === 0) return '';

    const records: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const values = this.splitCsvLine(lines[i]);
      if (values.length === 0) continue;

      const pairs: string[] = [];
      for (let j = 0; j < headers.length; j++) {
        const header = headers[j];
        const val = values[j] !== undefined ? values[j] : '';
        if (header && val) {
          pairs.push(`${header}: ${val}`);
        }
      }
      if (pairs.length > 0) {
        records.push(`Fila ${i}: ${pairs.join('; ')}.`);
      }
    }

    return records.join('\n\n');
  }

  /**
   * Simple CSV line splitter handling quoted strings and commas.
   */
  private static splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result.map((r) => r.replace(/^"(.*)"$/, '$1').trim());
  }

  /**
   * Parses JSON objects/arrays into structured readable sentences.
   */
  private static parseJson(content: string): string {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item, idx) => `Item ${idx + 1}: ${this.formatJsonObject(item)}`)
          .join('\n\n');
      } else if (typeof parsed === 'object' && parsed !== null) {
        return this.formatJsonObject(parsed);
      }
      return String(parsed);
    } catch {
      return this.normalizeText(content);
    }
  }

  private static formatJsonObject(obj: Record<string, unknown>): string {
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
      .join('; ') + '.';
  }

  /**
   * Cleans markdown formatting while preserving headers and structure.
   */
  private static parseMarkdown(content: string): string {
    let clean = content
      // Remove inline image markdown ![alt](url)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Convert links [text](url) to text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Remove horizontal rules
      .replace(/^(?:---|\*\*\*|___)\s*$/gm, '')
      // Standardize headers
      .replace(/^(#{1,6})\s+/gm, '$1 ');

    return this.normalizeText(clean);
  }

  /**
   * Extracts text from PDF text dumps or base64 streams.
   */
  private static parsePdfText(content: string): string {
    // If base64-encoded, decode to utf-8 text if valid
    if (/^[A-Za-z0-9+/=]+$/.test(content.trim()) && content.length % 4 === 0) {
      try {
        const decoded = Buffer.from(content, 'base64').toString('utf-8');
        if (/[\x20-\x7E\s]/.test(decoded)) {
          return this.normalizeText(decoded);
        }
      } catch {
        // Fall back to original
      }
    }
    return this.normalizeText(content);
  }
}
