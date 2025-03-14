import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NgIf } from '@angular/common';
import { HexMazeComponent } from './hex-maze.component';

describe('HexMazeComponent', () => {
  let component: HexMazeComponent;
  let fixture: ComponentFixture<HexMazeComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HexMazeComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(HexMazeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
