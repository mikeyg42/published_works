// src/app/app.config.ts
import { importProvidersFrom, ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { VonGridService } from './hex-maze/services/von-grid.service';
import { MainAnimation } from './hex-maze/services/main_animation';
import { PathTracerService } from './hex-maze/services/pathTracing_webgpu.service';
import { MazeSceneManager } from './hex-maze/services/maze-scene-manager';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(),
    provideRouter(routes),
    importProvidersFrom(),

    VonGridService,
    MainAnimation,
    MazeSceneManager,
    PathTracerService
  
    // Optionally, if you need APP_INITIALIZER 
  ]
};