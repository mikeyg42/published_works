// server side 
// src/main.server.ts

// frontend/main.server.ts

import { enableProdMode, ApplicationRef  } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { config } from './app/app.config.server';

// Enable production mode if running in production
  if (process.env['NODE_ENV'] === 'production') {
  enableProdMode();
}

/**
 * Bootstraps the Angular application on the server side.
 * This function can be extended to include additional server-specific
 * configurations, logging, or middleware as needed.
 */
export default async function bootstrap(): Promise<ApplicationRef> {
  try {
    const appRef = await bootstrapApplication(AppComponent, config);
    console.log('Application bootstrapped successfully on the server.');
    return appRef;
  } catch (error) {
    console.error('Error bootstrapping the application:', error);
    process.exit(1);
  }
}