import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { Observable, of } from 'rxjs';
import { MazeGeneratorService, PathMap } from './maze-generator.service';
import { isPlatformBrowser } from '@angular/common';

export interface MazeData {
  pathMap: PathMap;
}

@Injectable({
  providedIn: 'root'
})
export class MazeApiService {
  constructor(
    private mazeGeneratorService: MazeGeneratorService,
    @Inject(PLATFORM_ID) private platformId: Object
  ) {}

  getMazeData(
    width: number,
    height: number
  ): Observable<MazeData> {
    if (!isPlatformBrowser(this.platformId)) {
      return of({ pathMap: null as any });
    }
    console.log('Generating maze:', width, height);
    return of({
      pathMap: this.mazeGeneratorService.generateMaze(width, height)
    });
  }
}