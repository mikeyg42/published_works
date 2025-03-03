// src/app/bold-name.pipe.spec.ts

import { BoldNamePipe } from './bold-name.pipe';
import { TestBed } from '@angular/core/testing';
import { DomSanitizer, BrowserModule } from '@angular/platform-browser';

describe('BoldNamePipe', () => {
  let pipe: BoldNamePipe;
  let sanitizer: DomSanitizer;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [BrowserModule],
      providers: [BoldNamePipe],
    });

    sanitizer = TestBed.inject(DomSanitizer);
    pipe = new BoldNamePipe(sanitizer);
  });

  it('should create an instance', () => {
    expect(pipe).toBeTruthy();
  });

  // Single Author - Exact Match
  it('should bold "Michael D. Glendinning" in a single-author list', () => {
    const input = 'Michael D. Glendinning';
    const expected = '<strong>Michael D. Glendinning</strong>';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Single Author - Initial Match
  it('should bold "M Glendinning" when first initial matches', () => {
    const input = 'M Glendinning';
    const expected = '<strong>M Glendinning</strong>';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Single Author - No Initial Match
  it('should not bold "E Glendinning" when first initial does not match', () => {
    const input = 'E Glendinning';
    const expected = 'E Glendinning';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Multiple Authors - One Match
  it('should bold only "Michael D. Glendinning" in a multi-author list', () => {
    const input = 'Kiran T Thakur*, Emily Happy Miller*, Michael D. Glendinning*, Osama Al-Dalahmah';
    const expected = 'Kiran T Thakur*, Emily Happy Miller*, <strong>Michael D. Glendinning*</strong>, Osama Al-Dalahmah';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Multiple Authors - Multiple Matches
  it('should bold multiple occurrences of "M Glendinning" in the authors list', () => {
    const input = 'M Glendinning, Emily Happy Miller, M Glendinning*';
    const expected = '<strong>M Glendinning</strong>, Emily Happy Miller, <strong>M Glendinning*</strong>';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Initials Before Last Name
  it('should bold "M. Glendinning" in the authors list', () => {
    const input = 'M. Glendinning, Emily Happy Miller';
    const expected = '<strong>M. Glendinning</strong>, Emily Happy Miller';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Case Insensitivity
  it('should bold the name regardless of case', () => {
    const input = 'emily happy miller, michael d. glendinning, osama al-dalahmah';
    const expected = 'emily happy miller, <strong>michael d. glendinning</strong>, osama al-dalahmah';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Names with Special Characters
  it('should bold names with special characters', () => {
    const input = 'J. Doe, Emily Happy Miller';
    const expected = '<strong>J. Doe</strong>, Emily Happy Miller';
    const result = pipe.transform(input, 'J', 'Doe');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Names with Asterisks and Periods
  it('should bold "M. Glendinning*" correctly', () => {
    const input = 'Emily Happy Miller, M. Glendinning*, Osama Al-Dalahmah';
    const expected = 'Emily Happy Miller, <strong>M. Glendinning*</strong>, Osama Al-Dalahmah';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // No Alteration if Name Not Present
  it('should not alter text if the name is not present', () => {
    const input = 'Emily Happy Miller, Osama Al-Dalahmah';
    const expected = 'Emily Happy Miller, Osama Al-Dalahmah';
    const result = pipe.transform(input, 'M', 'Glendinning');
    expect(sanitizer.sanitize(1, result)).toBe(expected);
  });

  // Handle Null or Undefined Input
  it('should handle null or undefined input', () => {
    expect(pipe.transform(null, 'M', 'Glendinning')).toBe('');
    expect(pipe.transform(undefined, 'M', 'Glendinning')).toBe('');
  });
});
