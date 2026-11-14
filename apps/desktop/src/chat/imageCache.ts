/**
 * Pictures already read from the app, kept so a message scrolled back into view shows its
 * picture at once. A picture is a data URL as long as the file, so the cache has a budget and
 * lets go of the ones looked at longest ago, instead of holding every picture of a long chat.
 */
export class ImageCache {
  private readonly entries = new Map<string, string>();
  private size = 0;

  constructor(private readonly budget: number) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.size -= old.length;
      this.entries.delete(key);
    }
    // One picture larger than the whole budget is shown but not kept.
    if (value.length > this.budget) {
      return;
    }
    this.entries.set(key, value);
    this.size += value.length;
    for (const [oldest, text] of this.entries) {
      if (this.size <= this.budget) {
        break;
      }
      this.entries.delete(oldest);
      this.size -= text.length;
    }
  }

  get bytes(): number {
    return this.size;
  }

  clear(): void {
    this.entries.clear();
    this.size = 0;
  }
}
