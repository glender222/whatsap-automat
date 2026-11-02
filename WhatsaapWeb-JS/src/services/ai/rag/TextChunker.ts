import type { ChunkingConfigV1 } from '@whatsap-automat/contracts';

export interface ChunkItem {
  index: number;
  text: string;
  tokenCount: number;
  startChar: number;
  endChar: number;
}

export class TextChunker {
  /**
   * Estimates token count based on standard English/Spanish heuristic (~4 chars per token).
   */
  static estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.trim().length / 4));
  }

  /**
   * Slices text into overlapping chunks using paragraph and sentence boundaries.
   */
  static chunk(fullText: string, config?: Partial<ChunkingConfigV1>): ChunkItem[] {
    const chunkSizeTokens = config?.chunkSizeTokens || 512;
    const overlapTokens = config?.overlapTokens !== undefined ? config.overlapTokens : 64;
    const maxChars = chunkSizeTokens * 4;
    const overlapChars = overlapTokens * 4;

    const trimmed = fullText.trim();
    if (!trimmed) {
      return [];
    }

    // Split text by paragraph boundaries
    const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    const chunks: ChunkItem[] = [];
    let currentBuffer = '';
    let currentStart = 0;
    let chunkIndex = 0;

    for (const para of paragraphs) {
      // If single paragraph exceeds maxChars, split it by sentence or fixed window
      if (para.length > maxChars) {
        if (currentBuffer.trim().length > 0) {
          chunks.push({
            index: chunkIndex++,
            text: currentBuffer.trim(),
            tokenCount: this.estimateTokens(currentBuffer.trim()),
            startChar: currentStart,
            endChar: currentStart + currentBuffer.length,
          });
          currentBuffer = '';
        }

        const sentences = para.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 0);
        let subBuffer = '';
        for (const sentence of sentences) {
          if ((subBuffer.length + sentence.length) > maxChars && subBuffer.length > 0) {
            chunks.push({
              index: chunkIndex++,
              text: subBuffer.trim(),
              tokenCount: this.estimateTokens(subBuffer.trim()),
              startChar: currentStart,
              endChar: currentStart + subBuffer.length,
            });
            const rewind = Math.max(0, subBuffer.length - overlapChars);
            const overlap = subBuffer.slice(rewind);
            currentStart = currentStart + subBuffer.length - overlap.length;
            subBuffer = overlap + ' ' + sentence;
          } else {
            subBuffer = subBuffer ? subBuffer + ' ' + sentence : sentence;
          }
        }
        if (subBuffer.trim().length > 0) {
          currentBuffer = subBuffer;
        }
        continue;
      }

      if ((currentBuffer.length + para.length + 2) > maxChars && currentBuffer.length > 0) {
        chunks.push({
          index: chunkIndex++,
          text: currentBuffer.trim(),
          tokenCount: this.estimateTokens(currentBuffer.trim()),
          startChar: currentStart,
          endChar: currentStart + currentBuffer.length,
        });

        // Compute overlap rewind
        const rewindIndex = Math.max(0, currentBuffer.length - overlapChars);
        const overlapText = currentBuffer.slice(rewindIndex);
        currentStart = currentStart + currentBuffer.length - overlapText.length;
        currentBuffer = overlapText + '\n\n' + para;
      } else {
        currentBuffer = currentBuffer ? currentBuffer + '\n\n' + para : para;
      }
    }

    if (currentBuffer.trim().length > 0) {
      chunks.push({
        index: chunkIndex++,
        text: currentBuffer.trim(),
        tokenCount: this.estimateTokens(currentBuffer.trim()),
        startChar: currentStart,
        endChar: currentStart + currentBuffer.length,
      });
    }

    return chunks;
  }
}
