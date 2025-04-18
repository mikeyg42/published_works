// src/app/bold-name.pipe.ts

import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Pipe({
  name: 'boldName',
  standalone: true
})
export class BoldNamePipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);

  /**
   * Transforms the authors' list by bolding the specified name based on first initial and last name.
   *
   * @param value The authors' list as a comma-separated string.
   * @param firstName The first name of the name to bold (e.g., 'Michael').
   * @param lastName The unique last name to bold (e.g., 'Glendinning').
   * @returns The transformed SafeHtml string with the matching name bolded.
   */
  transform(
    value: string | null | undefined,
    firstName: string = 'Michael',
    lastName: string = 'Glendinning'
  ): SafeHtml {
    if (!value || !firstName|| !lastName) return value || '';
    
    const firstInitial = firstName.charAt(0);
    // Normalize the inputs for comparison
    const normalizedLastName = this.normalizeName(lastName);
    const normalizedFirstInitial = this.normalizeName(firstInitial).charAt(0);

    // Regex to find potential names
    const nameRegex = /([^,]+)(,[^,]+)?/g;
    let matches;
    let result = value;
    
    // Find all potential name segments in the string
    while ((matches = nameRegex.exec(value)) !== null) {
      const fullMatch = matches[0];
      const normalizedMatch = this.normalizeName(fullMatch);
      
      // Check if the segment contains both last name and first initial
      if (normalizedMatch.includes(normalizedLastName) && 
          normalizedMatch.includes(normalizedFirstInitial)) {
        // Bold the entire name segment
        result = result.replace(fullMatch, `<strong>${fullMatch}</strong>`);
      }
    }

    return this.sanitizer.bypassSecurityTrustHtml(result);
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
