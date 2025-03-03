import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { Observable, of } from 'rxjs';
import { MazeGeneratorService } from './maze-generator.service';
import { PathMap } from './maze-generator.service';
import { isPlatformBrowser } from '@angular/common';

export interface MazeData {
  imageData: ImageData;
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
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): Observable<MazeData> {
    if (!isPlatformBrowser(this.platformId)) {
      return of({ imageData: new ImageData(1, 1), pathMap: null as any });
    }
    console.log('Generating maze:', width, height);
    return of(this.mazeGeneratorService.generateMaze(ctx, width, height));
  }
}