/**
 * lineTextHoverAnimation.js
 *
 * This module prepares any text element marked with the 'line-hover' class.
 * It splits the text content into individual span elements (each with the class 'char')
 * and appends a dedicated blinking cursor element.
 *
 * Usage:
 * 1. Add the 'line-hover' class to any text element in your HTML.
 * 2. Import this module and call the function (optionally passing a selector).
 *
 * Example HTML:
 *   <h1 class="line-hover">My Resume</h1>
 *
 * Example usage in your main JS file:
 *   import { ApplyLineTextHoverAnimation } from './animations/animation.lineTextHoverEffect';
 *   ApplyLineTextHoverAnimation();
 */

export default function ApplyLineTextHoverAnimation(selector = '.line-hover') {
  // Query for all elements that should get the hover effect.
  const elements = document.querySelectorAll(selector);
  
  elements.forEach(element => {
    // Get the original text and clear the element.
    const originalText = element.textContent;
    element.textContent = '';

    // Create a document fragment for performance.
    const fragment = document.createDocumentFragment();

    // Wrap each character in a span element with a 'char' class.
    for (let char of originalText || '') {
      const span = document.createElement('span');
      span.classList.add('char');
      span.textContent = char;
      fragment.appendChild(span);
    }
    
    // Create and append the cursor element.
    const cursor = document.createElement('div');
    cursor.classList.add('cursor');
    fragment.appendChild(cursor);

    // Reinsert the fragment back into the element.
    element.appendChild(fragment);
  });
}
