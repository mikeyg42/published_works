// src/app/bold-name.pipe.ts

import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Pipe({
  name: 'boldName',
  standalone: true
})
export class BoldNamePipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  /**
   * Transforms the authors' list by bolding the specified name based on first initial and last name.
   *
   * @param value The authors' list as a comma-separated string.
   * @param firstInitial The first initial of the name to bold (e.g., 'M').
   * @param lastName The unique last name to bold (e.g., 'Glendinning').
   * @returns The transformed SafeHtml string with the matching name bolded.
   */
  transform(
    value: string | null | undefined,
    firstInitial: string = 'M',
    lastName: string = 'Glendinning'
  ): SafeHtml {
    if (!value || !firstInitial || !lastName) return value || '';

    // Split the authors' list by commas
    const authors = value.split(',');

    // Normalize the last name for comparison
    const normalizedLastName = this.normalizeName(lastName);

    // Normalize the first initial
    const normalizedFirstInitial = this.normalizeName(firstInitial).charAt(0);

    // Process each author name
    const processedAuthors = authors.map(author => {
      const trimmedAuthor = author.trim();
      const normalizedAuthor = this.normalizeName(trimmedAuthor);

      // Check if the author's last name matches
      if (normalizedAuthor.includes(normalizedLastName)) {
        // Extract the first character (initial) from the author's name
        const authorInitial = normalizedAuthor.charAt(0);

        // If the initial matches, bold the author's name
        if (authorInitial === normalizedFirstInitial) {
          return `<strong>${trimmedAuthor}</strong>`;
        }
      }

      // Return the original author name if no match
      return trimmedAuthor;
    });

    // Reconstruct the authors' list
    const newValue = processedAuthors.join(', ');

    return this.sanitizer.bypassSecurityTrustHtml(newValue);
  }

  /**
   * Normalizes a name by converting to lowercase and removing punctuation.
   *
   * @param name The name string to normalize.
   * @returns The normalized name string.
   */
  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[.,*]/g, '') // Remove periods, commas, asterisks
      .trim();
  }
}
