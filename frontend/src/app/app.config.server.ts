// src/app/app.config.server.ts
import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { provideServerRouting, ServerRoute } from '@angular/ssr';
import { appConfig } from './app.config';
import { routes } from './app.routes';

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRouting(routes as ServerRoute[])
  ]
};

export const config = mergeApplicationConfig(appConfig, serverConfig);