// modal.component.ts
import {
  Component,
  Input,
  HostListener,
  Output,
  EventEmitter,
  Inject, 
  PLATFORM_ID, 
  ViewChild,
  ElementRef,
  AfterViewInit,
  OnDestroy
} from '@angular/core';
import { isPlatformBrowser, CommonModule } from '@angular/common';
import { A11yModule, FocusTrap, FocusTrapFactory } from '@angular/cdk/a11y';

@Component({
  selector: 'app-modal',
  templateUrl: './modal.component.html',
  styleUrls: ['./modal.component.scss'],
  standalone: true,
  imports: [CommonModule, A11yModule],
})

export class ModalComponent implements AfterViewInit, OnDestroy {
  @Input() src: string = '';
  @Input() isVideo: boolean = false;
  @Input() imageWidth?: number;
  @Input() imageHeight?: number;
  @Input() imageAlt?: string;
  @Output() modalClosed = new EventEmitter<void>();
  @Output() zoomChanged = new EventEmitter<number>();

  @ViewChild('mediaElement') mediaElement!: ElementRef<HTMLImageElement | HTMLVideoElement>;
  @ViewChild('modalContent') modalContent!: ElementRef<HTMLDivElement>;
  @ViewChild('mediaContainer') mediaContainer!: ElementRef<HTMLDivElement>;

  zoomLevels: number[] = [
   0.2, 0.35, 0.5, 0.7, 0.8, 0.9, 0.96, 1, 1.2, 1.4, 1.6, 1.8, 2,
    2.25, 2.5, 2.75, 3, 3.3, 3.6, 4, 5, 6, 7, 8, 10,
  ];
  initialZoom: number = 1;  
  levelIndex: number = -1; // Adjusted after finding index of '1' in the array
  currentZoom: number = 1;

  // Flags to track media loading and errors
  isMediaLoaded: boolean = false;
  hasError: boolean = false;

  // To store the previously focused element
  private previouslyFocusedElement: HTMLElement | null = null;
  private focusTrap: FocusTrap | null = null;

  // Add properties to track zoom limits
  isMaxZoom: boolean = false;
  isMinZoom: boolean = false;

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private focusTrapFactory: FocusTrapFactory
  ) {}

  ngAfterViewInit() {
    if (isPlatformBrowser(this.platformId)) {
      // Save the currently focused element
      this.previouslyFocusedElement = document.activeElement as HTMLElement;

      // Create a focus trap
      this.focusTrap = this.focusTrapFactory.create(this.modalContent.nativeElement);
      // Focus initial element
      this.focusTrap.focusInitialElementWhenReady();
    }
  }

  ngOnDestroy() {
    // Restore focus to the previously focused element
    if (this.previouslyFocusedElement) {
      this.previouslyFocusedElement.focus();
    }
    // Destroy the focus trap
    if (this.focusTrap) {
      this.focusTrap.destroy();
    }
  }

  onMediaLoad(event: Event) {
    // Once media is loaded, calculate zoom
    this.calculateInitialZoom();
    this.isMediaLoaded = true;
  }

  onMediaError(event: Event) {
    this.hasError = true;
    console.error('Failed to load media:', event);
    this.modalClosed.emit(); // Optionally close the modal on error
  }

  calculateInitialZoom() {
    // Find the index of zoom level '1'
    this.levelIndex = this.zoomLevels.findIndex(zoom => zoom === 1);

    // Get modal dimensions
    const modal = this.modalContent.nativeElement;
    const modalWidth = modal.clientWidth;
    const modalHeight = modal.clientHeight;

    if (modalWidth === 0 || modalHeight === 0 || !this.imageWidth || !this.imageHeight) {
      console.error('Cannot calculate initial zoom.');
      // Set default scale
      this.initialZoom = 1;
      this.currentZoom = 1;
      this.zoomChanged.emit(this.currentZoom);
      return;
    }

    // Calculate scale factors
    const scaleWidth = modalWidth / this.imageWidth;
    const scaleHeight = modalHeight / this.imageHeight;

    // Adjust to fit within modal (85% to add some padding)
    this.initialZoom = Math.min(scaleWidth, scaleHeight) * 0.85;
    this.currentZoom = this.initialZoom;
    this.zoomChanged.emit(this.currentZoom);
  }

  updateZoomLevel() {
    const zoomMultiplier = this.zoomLevels[this.levelIndex];
    this.currentZoom = this.initialZoom * zoomMultiplier;
    this.zoomChanged.emit(this.currentZoom);
    
    // Update zoom limits
    this.isMaxZoom = this.levelIndex === this.zoomLevels.length - 1;
    this.isMinZoom = this.levelIndex === 0;
  }

  zoomIn() {
    if (this.levelIndex < this.zoomLevels.length - 1) {
      this.levelIndex++;
      this.updateZoomLevel();
    }
  }

  zoomOut() {
    if (this.levelIndex > 0) {
      this.levelIndex--;
      this.updateZoomLevel();
    }
  }

  toggleZoom() {
    // Reset to zoom level '1'
    this.levelIndex = this.zoomLevels.findIndex(zoom => zoom === 1);
    this.updateZoomLevel();
  }

  close() {
    this.modalClosed.emit();
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscapePress(event: KeyboardEvent) {
    this.close();
  }

  @HostListener('window:resize', ['$event'])
  onWindowResize(event: Event) {
    this.handleResize(event);
  }

  handleResize(event: Event) {
    this.calculateInitialZoom();
  }

  onMediaContainerClick(event: MouseEvent) {
    // Only close if clicking directly on the container (not the media)
    if (event.target === this.mediaContainer.nativeElement) {
      this.close();
    }
  }

  // Handle clicks on the overlay
  onOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  // Add touch gesture support
  @HostListener('touchstart', ['$event'])
  onTouchStart(event: TouchEvent) {
    if (event.touches.length === 2) {
      event.preventDefault(); // Prevent default zoom
    }
  }

  // Improve keyboard navigation
  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case 'Escape':
        this.close();
        break;
      case '+':
      case '=':
        this.zoomIn();
        break;
      case '-':
        this.zoomOut();
        break;
      case '0':
        this.toggleZoom();
        break;
    }
  }

  // Add orientation change handler
  @HostListener('window:orientationchange', ['$event'])
  onOrientationChange(event: Event) {
    // Wait for orientation change to complete
    setTimeout(() => {
      this.calculateInitialZoom();
    }, 100);
  }
}
