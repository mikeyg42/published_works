// src/app/app.component.spec.ts

import { TestBed, ComponentFixture } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { BoldNamePipe } from './bold-name.pipe';
import { BrowserModule } from '@angular/platform-browser';

describe('AppComponent', () => {
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent, BoldNamePipe, BrowserModule],
      // No declarations since AppComponent is standalone
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the app component', () => {
    expect(component).toBeTruthy();
  });

  it(`should have as title 'Michael Glendinning'`, () => {
    expect(component.title).toEqual('Michael Glendinning');
  });

  it('should render the header with bolded name', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const headerTitle = compiled.querySelector('header h1');
    expect(headerTitle).toBeTruthy();
    expect(headerTitle?.innerHTML).toContain('<strong>Michael Glendinning</strong>');
  });

  it('should render publications with bolded names in authors', () => {
    const compiled = fixture.nativeElement as HTMLElement;
  
    // Check Authors
    const publicationAuthors = compiled.querySelectorAll('.publication-list li .authors span');
    publicationAuthors.forEach((author) => {
      // Ensure my last name is bolded
      expect(author.innerHTML).toMatch(/<strong>.*Glendinning.*<\/strong>/);
    });
  });
  

  it('should display the "Download Resume" button', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const resumeButton = compiled.querySelector('.download-resume-btn');
    expect(resumeButton).toBeTruthy();
    expect(resumeButton?.getAttribute('href')).toContain(component.resumeUrl);
  });

  it('should open and close the image modal correctly', () => {
    //???
  });
});
