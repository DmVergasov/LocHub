import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout: give elements a viewport-sized box so the virtualized grid renders rows.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });

// jsdom does not model window/tab focus, so document.hasFocus() always answers false regardless of any element's
// focus state; default it to true (matching an ordinary, active browser tab) so code that treats a real loss of
// document focus as a signal (e.g. a blur handler distinguishing "the whole window lost focus" from "focus moved
// within the page") behaves the same way here as in a real browser, unless a test explicitly mocks it otherwise.
Object.defineProperty(document, 'hasFocus', { configurable: true, writable: true, value: () => true });

afterEach(() => {
  cleanup();
});
