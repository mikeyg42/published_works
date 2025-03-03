interface Publication {
  title: string;
  authors: string;
  journal: string;
  meeting?: string;
  year: string;
  abstract: string;
  journalLink?: string;
  directDownload?: string;
  imageSrc?: string;
  imageSrc2?: string;
  videoSrc?: string;
  showAbstract: boolean;
  width1?: number;
  height1?: number;
  width2?: number;
  height2?: number;
  id: number;
  isActive: boolean;
  isExpanded: boolean;
  isHovered: boolean;
  images?: Array<{url: string, alt: string}>;

}

import { 
  Component, 
  ViewEncapsulation, 
  HostListener, 
  OnInit,
  OnDestroy,
  Inject, 
  PLATFORM_ID,
  ChangeDetectionStrategy, 
  AfterViewInit,
  ElementRef,
  ViewChildren,
  QueryList
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NgOptimizedImage } from '@angular/common';
import { BoldNamePipe } from './bold-name.pipe';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ModalComponent } from './modal/modal.component';
import { HexMazeComponent } from './hex-maze/hex-maze.component';
import { Meta, Title } from '@angular/platform-browser';
import ApplyLineTextHoverAnimation from './animations/animation.lineTextHoverEffect';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HexMazeComponent,
    CommonModule,
    RouterModule,
    NgOptimizedImage,
    BoldNamePipe,
    ModalComponent
  ]
})
export class AppComponent implements OnInit, OnDestroy, AfterViewInit {
  @ViewChildren('card') cards!: QueryList<ElementRef>;

  title = 'Michael<br>Glendinning';
  resumeUrl: string = 'https://storage.googleapis.com/resume_page/content/MichaelResume.pdf';

  modalSrc: string = '';
  isModalOpen: boolean = false;
  isVideoModal: boolean = false;
  modalImageWidth?: number;
  modalImageHeight?: number;

  bioText: SafeHtml = '';

  minColumnWidth: number = 0;
  gridGap: number = 0;
  sidebarWidth: number = 0;
  outerPadding: number = 0;
  gridTemplateColumns: string = '';
  
  private resizeTimeout: number | null = null;
  private sr: any;

  articles: Publication[] = [
    {
      title: 'VEGF-A-mediated venous endothelial cell proliferation results in neoangiogenesis during neuroinflammation',
      authors: 'Sanjid Shahriar*, Saptarshi Biswas*, Kaitao Zhao, Uğur Akcan, Mary Claire Tuohy, Michael D Glendinning , Ali Kurt , Charlotte R Wayne , Grace Prochilo, Maxwell Z Price, Heidi Stuhlmann, Rolf A Brekken, Vilas Menon, Dritan Agalliu',      
      journal: 'Nature Neuroscience',
      meeting: '',
      year: '2024',
      abstract: 'Newly formed leaky vessels and blood-brain barrier (BBB) damage are present in demyelinating acute and chronic lesions in multiple sclerosis (MS) and experimental autoimmune encephalomyelitis (EAE). However, the endothelial cell subtypes and signaling pathways contributing to these leaky neovessels are unclear. Here, using single-cell transcriptional profiling and in vivo validation studies, we show that venous endothelial cells express neoangiogenesis gene signatures and show increased proliferation resulting in enlarged veins and higher venous coverage in acute and chronic EAE lesions in female adult mice. These changes correlate with the upregulation of vascular endothelial growth factor A (VEGF-A) signaling. We also confirmed increased expression of neoangiogenic markers in acute and chronic human MS lesions. Treatment with a VEGF-A blocking antibody diminishes the neoangiogenic transcriptomic signatures and vascular proliferation in female adult mice with EAE, but it does not restore BBB function or ameliorate EAE pathology. Our data demonstrate that venous endothelial cells contribute to neoangiogenesis in demyelinating neuroinflammatory conditions.',
      journalLink:'10.1038/s41593-024-01746-9',
      directDownload: 'https://storage.googleapis.com/resume_page/content/MS_vegf-a_shariar2024.pdf',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/snippet%20from%20human%20ms%20project.png',
      imageSrc2: 'https://storage.googleapis.com/resume_page/content/Screenshot%202024-09-14%20at%2018.01.07.png',
      videoSrc:'',
      width1: 1169,
      height1: 358,
      width2: 1162,
      height2: 504,
      showAbstract: false,
      id:0,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'Rab7a activation promotes degradation of select tight junction proteins at the blood-brain barrier after ischemic stroke',
      authors: 'Azzurra Cottarelli, Sanjid Shahriar*, Ahmet Arac*, Michael Glendinning, Mary Claire Tuohy, Grace Prochilo, Jason B. Neal, Aimee L. Edinger, and Dritan Agalliu',
      journal: 'BioRxiv',
      meeting: '',
      year: '2023',
      abstract: 'The stability of tight junctions (TJs) between endothelial cells (ECs) is essential to maintain blood-brain barrier (BBB) function in the healthy brain. Following ischemic stroke, TJ strand dismantlement due to protein degradation leads to BBB dysfunction, yet the mechanisms driving this process are poorly understood. Here, we show that endothelial-specific ablation of Rab7a, a small GTPase that regulates endolysosomal protein degradation, reduces stroke-induced TJ strand disassembly resulting in decreased paracellular BBB permeability and improved neuronal outcomes. Two pro-inflammatory cytokines, TNFα and IL1β, but not glucose and oxygen deprivation, induce Rab7a activation via Ccz1 in brain ECs in vitro, leading to increased TJ protein degradation and impaired paracellular barrier function. Silencing Rab7a in brain ECs in vitro reduces cytokine-driven endothelial barrier dysfunction by suppressing degradation of a key BBB TJ protein, Claudin-5. Thus, Rab7a activation by inflammatory cytokines promotes degradation of select TJ proteins leading to BBB dysfunction after ischemic stroke.',
      journalLink:'https://www.biorxiv.org/content/10.1101/2023.08.29.555373v1',
      directDownload: 'https://storage.googleapis.com/resume_page/content/rab7a%20paper.pdf',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/rab7a_4.png',
      videoSrc:'https://storage.googleapis.com/resume_page/content/rab7a%20leakage%20video.m4v',
      imageSrc2: '',
      width1: 431,
      height1: 240,
      width2: 637,
      height2: 358,
      showAbstract: false,
      id:1,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'miR-126 regulates glycogen trophoblast proliferation and DNA methylation in the murine placenta',
      authors: 'Abhijeet Sharma, Lauretta A Lacko, Lissenya B Argueta, Michael D Glendinning, Heidi Stuhlmann',
      journal: 'Developmental Biology',
      meeting: '',
      year: '2019',
      abstract: 'A functional placenta develops through a delicate interplay of its vascular and trophoblast compartments. We have identified a previously unknown expression domain for the endothelial-specific microRNA miR-126 in trophoblasts of murine and human placentas. Here, we determine the role of miR-126 in placental development using a mouse model with a targeted deletion of miR-126. In addition to vascular defects observed only in the embryo, loss of miR-126 function in the placenta leads to junctional zone hyperplasia at E15.5 at the expense of the labyrinth, reduced placental volume for nutrient exchange and intra-uterine growth restriction of the embryos. Junctional zone hyperplasia results from increased numbers of proliferating glycogen trophoblast (GlyT) progenitors at E13.5 that give rise to an expanded glycogen trophoblast population at E15.5. Transcriptomic profile of miR-126-/- placentas revealed dysregulation of a large number of GlyT (Prl6a1, Prl7c1, Pcdh12) and trophoblast-specific genes (Tpbpa, Tpbpb, Prld1) and genes with known roles in placental development. We show that miR-126-/- placentas, but not miR-126-/- embryos, display aberrant expression of imprinted genes with important roles in glycogen trophoblasts and junctional zone development, including Igf2, H19, Cdkn1c and Phlda2, during mid-gestation. We also show that miR126-/- placentas display global hypermethylation, including at several imprint control centers. Our findings uncover a novel role for miR-126 in regulating extra-embryonic energy stores, expression of imprinted genes and DNA methylation in the placenta.',
      journalLink: 'https://doi.org/10.1016/j.ydbio.2019.01.019',
      directDownload: 'https://storage.googleapis.com/resume_page/content/mir126%20paper%20complete.pdf',
      imageSrc2:'',
      width1: 798,
      height1: 321,
      videoSrc:'',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/mir126_embryos.png',
      showAbstract: false,
      id:2,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'miR-126 modulates neural progenitor cell development',
      authors: 'Jeroen Bastiaans, Michhael D. Glendinning, Natalia de Marco Garcia, and Heidi Stuhlmann',
      journal: 'BioRxiv',
      meeting: '',
      year: '2024',
      abstract: 'Noncoding microRNAs (miRNAs) play important roles in controlling signaling pathways by targeting multiple genes and altering their expression levels. MiR-126 is a known endothelial-specific miRNA that regulates vascular integrity and angiogenesis by enhancing proangiogenic actions of VEGF and FGF. MiR-126 is also expressed in several stem cell compartments, including embryonic stem cell (ESC) and hematopoietic stem/progenitor cells (HSPC) where it regulates cell differentiation and quiescence. Here we show that miR-126 is expressed as well in neural progenitor cells where it regulates cell differentiation by targeting genes of the IGF1R signaling pathway including IRS1, PI3K and AKT. Moreover, Hoxa9 and IGF-1 expression by neural progenitor cells is upregulated when miR-126 expression levels are reduced. Our data, implicating a role for miR-126 in manipulating cell development, could open a window of opportunities for clinical purposes and therapeutic strategies to achieve controlling neural progenitor cell behavior.',
      journalLink: 'https://doi.org/10.1101/2024.12.27.630551',
      directDownload: '',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/mir126_embryos.png',
      width1: 520,
      height1: 571 ,
      videoSrc:'',
      imageSrc2: '',
      showAbstract: false,
      id:3,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'VEGF-A-mediated venous endothelial cell proliferation results in neoangiogenesis during neuroinflammation',
      authors: 'Sanjid Shahriar*, Saptarshi Biswas*, Kaitao Zhao, Uğur Akcan, Mary Claire Tuohy, Michael D Glendinning , Ali Kurt , Charlotte R Wayne , Grace Prochilo, Maxwell Z Price, Heidi Stuhlmann, Rolf A Brekken, Vilas Menon, Dritan Agalliu',      
      journal: 'Nature Neuroscience',
      meeting: '',
      year: '2024',
      abstract: 'Newly formed leaky vessels and blood-brain barrier (BBB) damage are present in demyelinating acute and chronic lesions in multiple sclerosis (MS) and experimental autoimmune encephalomyelitis (EAE). However, the endothelial cell subtypes and signaling pathways contributing to these leaky neovessels are unclear. Here, using single-cell transcriptional profiling and in vivo validation studies, we show that venous endothelial cells express neoangiogenesis gene signatures and show increased proliferation resulting in enlarged veins and higher venous coverage in acute and chronic EAE lesions in female adult mice. These changes correlate with the upregulation of vascular endothelial growth factor A (VEGF-A) signaling. We also confirmed increased expression of neoangiogenic markers in acute and chronic human MS lesions. Treatment with a VEGF-A blocking antibody diminishes the neoangiogenic transcriptomic signatures and vascular proliferation in female adult mice with EAE, but it does not restore BBB function or ameliorate EAE pathology. Our data demonstrate that venous endothelial cells contribute to neoangiogenesis in demyelinating neuroinflammatory conditions.',
      journalLink:'https://doi.org/10.1038/s41593-024-01746-9',
      directDownload: 'https://storage.googleapis.com/resume_page/content/MS_vegf-a_shariar2024.pdf',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/snippet%20from%20human%20ms%20project.png',
      imageSrc2: 'https://storage.googleapis.com/resume_page/content/Screenshot%202024-09-14%20at%2018.01.07.png',
      videoSrc:'',
      width1: 1169,
      height1: 358,
      width2: 1162,
      height2: 504,
      showAbstract: false,
      id:4,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
  ];

  abstracts: Publication[] = [
    {
      title: 'Social Networks in Pediatric-Onset Multiple Sclerosis are Associated with Less Negative Peer Pressure (P18-4.002)',
      authors: 'Micky Bacchus, Wendy Vargas, Michael Glendinning, Seth Levin, Kaho Onomichi, Philip De Jager, and Brenda Banwell',
      journal: 'Neurology',
      meeting: 'American Academy of Neurology',
      year: '2022',
      abstract: 'We developed a pediatric version of an established questionnaire used to evaluate social networks in AOMS. We asked participants (81 adolescents: 48 POMS, 33 HCs) to identify persons with whom they discuss important matters and included questions related to peer pressure. To establish internal validity, we deployed the questionnaire to a focus group of ten HCs before extending to our study cohort. Using graph theoretical statistics, we calculated three structural metrics for each individual social networks: size (number of network members, excluding the participant), maximum degree (highest number of ties by a network member), and mean degree (average number of ties by a network member). We assessed differences between groups using two-tailed student t-tests.\nResults:Among POMS, mean age was 18 years (±4.5); 74% female; median grade: college freshman. For HCs, average age was 19 years (±2.1); 67% female; median grade: college sophomore. POMS have smaller average networks (POMS: 13.1, HC: 16.1, p=0.03) and smaller mean degrees within their networks (POMS: 4.5, HC: 5.4, p=0.01). HCs reported a greater proportion of network members who encourage them to use marijuana and alcohol compared to POMS (p<0.001). In a composite score assessing negative health behaviors (staying out past curfew, skipping class, not completing homework, using marijuana and alcohol, eating junk food), HCs reported higher proportion of network members encouraging negative behaviors (POMS: 0.03, HC: 0.075, p=0.04).\n Conclusions:Unlike AOMS, where smaller social networks associate with isolation and reduced health outcomes, we found that the smaller networks of our POMS cohort were preferentially inhabited by positive peer influences. Our future work will explore whether these smaller networks associate with better quality of life.',      
      journalLink:'https://www.neurology.org/doi/10.1212/WNL.98.18_supplement.371',
      directDownload: '',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/snq_img2.png',
      videoSrc:'',
      imageSrc2: '',
      width1: 846,
      height1: 437,
      showAbstract: false,
      id:11,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title:'Academic Underachievement is Common in Pediatric-Onset Multiple Sclerosis (P4-4.006)',
      authors: 'Wendy Vargas, Michael Glendinning, Hannah Street, Nicole Ampatey, Gabriella Tosto-DAntonio, Robert Fee, Brenda Banwell, and Philip De Jager',
      journal: 'Neurology',
      meeting: 'American Academy of Neurology',
      year: '2022',
      abstract: 'Objective: The aim of this study was to determine the rate of and characterize academic deficits in pediatric-onset multiple sclerosis (POMS) and compare these to cognitive deficits. Background: Unlike with adult-onset MS, where a great deal is known about the effects of cognitive dysfunction on daily life, the functional impact in POMS is largely understudied. Design/Methods: We administered a battery of neuropsychological tests and the Woodcock Test of Achievement (WCJ) to 23 participants with POMS and 11 healthy children (HC). Academic underachievement was defined as: (1) a z score of ≤ −1.5 standard deviation (SD) on the WCJ based on age-based normative data, and/or (2) a failing score on ≥ 2 statewide exams. Cognitive impairment was defined as: a score ≤ −1.5 SD on a total ≥ 1/3 of all cognitive tests administered, compared to age-based norms. Results: 11 of 23 POMS (48%) demonstrated academic underachievement compared to 1 of 11 HC (9%) (p=0.03). 8 of 23 POMS (35%) met criteria for cognitive impairment, compared to zero HC (p=0.03). POMS scored lower than HC on the WCJ Total Achievement Scale (χ̄=93.2 vs χ̄=112.6; p=0.0024, CI= [7.38, 31.4]). POMS with academic deficits were not more likely to have cognitive impairment than POMS without academic deficits (p=0.06). POMS had significantly lower scores than HC on the timed fluency section of the WCJ (χ̄=88.3 vs. χ̄=105.9, p=0.00122, CI=[7.50, 27.7] and on a timed section of the IQ test versus untimed sections (p=0.005, CI= [−15.8, 3.04]). 40% of POMS scored ≥ 1SD above their age and gender norms on a self-report depression scale, while zero HC scored in that range.Conclusions: Children with MS demonstrate high levels of academic underachievement. Dedicated academic achievement testing should be part of the structured cognitive evaluation for children with MS. Extended time on tests may represent a crucial academic accommodation for this group.',
      journalLink:'https://www.neurology.org/doi/10.1212/WNL.98.18_supplement.3380',
      directDownload: '',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/neuropsychtesting_w_bootstrapping.png',
      width1: 751,
      height1: 859,
      videoSrc:'',
      imageSrc2: '',
      showAbstract: false,
      id:5,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'Social Networks in Pediatric-Onset Multiple Sclerosis are Associated with Less Peer Pressure',
      authors: 'Wendy Vargas, Micky Bacchus, Michael Glendinning, Kaho Onomichi, Seth Levin, Philip De Jager, and Brenda Banwell',
      journal: 'Multiple Sclerosis Journal',
      meeting: 'ECTRIMS',
      year: '2021',
      abstract: 'Introduction: Social networks are the web of social relationships that surround an individual. In adults with multiple sclerosis (MS), smaller and close-knit social networks have been associated with worsened physical function., Objectives/Aims: The aim of this study was to analyze social networks in children with pediatric onset MS (POMS) and compare to the networks of healthy adolescents (HCs). Methods: We developed a pediatric-specific version of the social network questionnaire, which is a validated tool used in adults with MS. We asked participants to identify peers and adults with whom they have discussed important matters. We included questions related to peer pressure. To establish internal validity, we deployed the social network questionnaire to a focus group of ten healthy adolescents before extending to a group of 49 subjects with POMS and 33 HCs. Using graph theoretical statistics, we calculated three structural metrics for each individuals social network: size, maximum degree, and mean degree. Size is the number of network members, excluding the patient. Maximum degree is the highest number of ties by a network member, and mean degree is average number of ties by a network member. We assessed differences between groups using two-tailed student t-tests. Results: Within the POMS group, mean age was 18 years old (±2.5); 73% were female; median grade: college freshman. Among HCs, average age was 19 years old (±2.1); 67% were female; median grade: college sophomore. We found a significant difference in social network size with MS subjects having smaller average social networks (POMS: 13.1, HC: 16.1, p=0.02). Children with MS had smaller mean degree within their networks (POMS: 4.5, HC: 5.4, p=0.02). Healthy children reported a greater proportion of network members who encourage them to use marijuana and alcohol compared to POMS (p<0.001). In a composite score assessing negative health behaviors (staying out past curfew, skipping class, not completing homework, using marijuana and alcohol, eating junk food), HCs reported a higher proportion of people in their network encouraging these negative behaviors (HC: 0.075, POMS: 0.03, p=0.04). Conclusions: We found that children with MS have smaller social networks than healthy children, and these networks are inhabited by people who are less likely to exert a negative influence. Our findings suggest that children with POMS tend to have social networks that are less likely to promote unhealthy behaviors.',
      journalLink:'https://doi.org/10.1177/13524585211044647',
      directDownload: 'https://storage.googleapis.com/resume_page/content/ectrims%202021%20social%20networks.pdf',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/social_network_substance_use.png',
      width1: 846,
      height1: 437,
      videoSrc:'',
      imageSrc2: '',
      showAbstract: false,
      id:6,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'Children with multiple sclerosis struggle academically to a greater extent than is predicted by standard neuropsychological testing',
      authors: 'Wendy S. Vargas, Michael D. Glendinning, Kaho Onomichi, Robert Fee, Victoria Leavitt, Samantha Epstein,  Claudiu Diaconu, Sarah Wesley, Rebecca Farber, Claire Riley, Philip L. De Jager',
      journal: 'Multiple Sclerosis Journal',
      meeting: 'ECTRIMS',
      year: '2021',
      abstract: 'Introduction: Cognitive impairment is a known sequela of pediatric-onset multiple sclerosis (POMS). However, academic achievement data in POMS are almost entirely unknown. Objectives/Aims: The aim of this study was to assess the rate of academic underachievement in POMS and identify related factors in this group.Methods: We collected results of statewide standardized exams and administered the Woodcock Johnson Test of Achievement III (WJII) to a cohort of 23 children with POMS and 10 healthy controls (HCs). We administered neuropsychological tests assessing global cognitive functioning, verbal recall, visuospatial functioning, processing speed, and fine motor speed and coordination. Academic underachievement was defined as a z-score ⩽ 1.5 standard deviations (SDs) below the mean on the WJIII or a grade < 65 on any statewide exam. Impairment on each neuropsychological test was defined as a z-score ⩽ 1.5 SDs below the mean. Participants were classified with cognitive impairment if the number of neuropsychological tests they scored ⩽-1.5 SDs divided by the total number of tests was ⩾ 1/3. We assessed differences between groups using two-tailed student t-tests. Results: Within the POMS group, mean age was 16.5 years old (±2.8); 78% were female and 56% Hispanic. Among HCs, average age was 14.2 years old (±2.9); 90% were female and 70% Hispanic. 48% of children with MS had academic underachievement compared to 10% of healthy children (p=0.039). However, 35% of children with MS had cognitive impairment compared to 20% of HCs (p=0.412). There was no significant difference between POMS subjects and HCs on any neuropsychological domains tested except fine motor speed and coordination. Academically underachieving POMS children were not on average more cognitively impaired than those with normal academic achievement (p=0.09). The only domain in which there was a significant difference between POMS academically impaired and non-impaired subjects was global cognitive functioning (p=0.005). POMS children with academic underachievement performed worse on neuropsychological tests that had a timed component compared to non-academically impaired (p=0.037). Conclusions: Our findings suggest that children with MS struggle academically to a greater extent than is predicted by standard neuropsychological testing. Children with MS and academic underachievement perform poorly on timed tests; extended time on tests could be an important academic accommodation in POMS.',
      journalLink:'https://doi.org/10.1177/13524585211044667',
      directDownload: 'https://storage.googleapis.com/resume_page/content/ectrims%202021%20neurosych%20testing%20screeners%20and%20academics.pdf',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/ECTRIMS%202021%20EOMS%20education%20poster.png',
      width1: 996,
      height1: 1365,
      videoSrc:'',
      imageSrc2: '',
      showAbstract: false,
      id:7,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'Neuropsychological tests do not adequately screen for academic impairment in children with multiple sclerosis.',
      authors: 'Wendy Vargas, Micky Bacchus, Michael Glendinning, Kaho Onomichi, Seth Levin, Philip De Jager, and Brenda Banwell',
      meeting: 'ECTRIMS',
      journal: 'Multiple Sclerosis Journal',
      year: '2021',
      abstract: 'Introduction: While the symbol digit modalities test (SDMT) is an effective screening test for cognitive impairment in pediatric-onset MS (POMS), the ideal screening test for academic impairment is not known. Objectives/Aims: The aim of this study was to analyze the sensitivity and specificity of different neuropsychological tests for predicting academic impairment in POMS. Methods: We collected results of statewide standardized exams and administered the following tests to a diverse cohort of 23 adolescents with POMS: Woodcock Johnson Test of Achievement III (WCJ), Wechsler Abbreviated Scale of Intelligence-II full scale IQ (FSIQ4), Trailmaking A (TA), Trailmaking B (TB), and the SDMT. Academic impairment was defined as a z-score ⩽ 1.5 standard deviations (SDs) below the mean on the WCJ or a grade <65 on any statewide exam. Sensitivities, specificities and receiver operating characteristic (ROC) curves were generated for FSIQ4, TA, TB, and SDMT for predicting academic impairment in the MS group. We assessed differences between groups using two-tailed student t-tests. Results: At a threshold of ⩽ 1.5 SDs below the mean, none of the neuropsychological tests had sufficient sensitivity for predicting academic impairment: FSIQ4 30%, TA 36%, TB 27%, and SDMT 45%. At this threshold, specificities for these tests were far better: FSIQ-4 100%, TA 75%, TB 83% and SDMT 92%. Even at a lower threshold of ⩽ 1 SDs below the mean, the sensitivities of these tests were poor: FSIQ4 60%, TA 45%, TB 45% and SDMT 55%. Based on ROC analysis, we found the area under the curve (AUC) to be: FSIQ4 0.83, TA 0.562, TB 0.727, SDMT 0.508; only the FSIQ4 and TB were statistically significantly. The disparity between the significant AUC and low sensitivities can in part be explained by the relatively high optimal cutoff-points from these ROC analyses (TB = -0.67 SDs and FSIQ4 = -0.31 SDs). In only the FSIQ4 was there any significant difference in group average (academically underachieving = 102.5, normal achievement = 83.7; p=0.002). Conclusions: The SDMT, TA, TB and FSIQ4 are not effective screening tests for academic impairment in POMS. Even with less stringent cut-offs for defining impairment, using these neuropsychological tests to screen for academic impairment in POMS would result in many false negatives. Children with MS require dedicated assessment of academic achievement as part of their cognitive evaluation.',
      journalLink:'https://doi.org/10.1177/13524585211044667',
      directDownload: 'https://storage.googleapis.com/resume_page/content/ectrims%202021%20neurosych%20testing%20screeners%20and%20academics.pdf',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/roc_curves_NPvsAU_clinicaltests.png',
      width1: 1728,
      height1: 728,
      videoSrc:'',
      imageSrc2: '',
      showAbstract: false,
      id:8,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'Analysis of COVID-19 Brain Autopsies Reveals That Neuroinflammation is Not Caused by Direct SARS-CoV-2 Infection of the CNS.',
      authors: 'Michael D. Glendinning*, Kiran T. Thakur*, Emily Happy Miller*, Osama Al-Dalahmah, Matei A. Banu, Amelia K. Boehme, Alexandra L. Boubour, Samuel L. Bruce, Alexander M. Chong, Jan Claassen, Phyllis L. Faust, Gunnar Hargus, Richard Hickman, Sachin Jambawalikar, Alexander G. Khandji, Carla Y. Kim, Robyn S. Klein, Angela Lignelli-Dipple, Chun-Chieh Lin, Yang Liu, Michael M. Miller, Gul Moonis, Anna S. Nordvig, Morgan L. Prust, William H. Roth, Allison Soung, Kurenai Tanji, Andrew F. Teich, Dritan Agalliu**, Anne-Catrin Uhlemann**, James E. Goldman**, Peter D. Canoll**',
      journal: 'CSHL Press',
      meeting: 'Cold Spring Harbor Laboratory: Brain Barriers',
      year: '2021',
      abstract: 'Many patients suffering from a SARS-CoV-2 infection develop neurological symptoms; however, it is unclear whether they are a consequence of direct viral infection of the CNS or due to secondary sequelae from the virus-induced systemic inflammatory response syndrome. In order to understand the mechanisms by which the SARS-CoV-2 systemic infection induces neurological symptoms, we collected brain samples from 41 consecutive COVID-19 patients undergoing autopsy at our medical center from April – June 2020. We characterized the degree of neuroinflammation in these cases by performing histopathological analysis of multiple brain regions and immunohistochemistry (IHC) for cell-specific markers, including macrophages and microglia (CD68 and Iba1), astrocytes (GFAP), lymphocytes (CD3 and CD20), and inflammatory cell adhesion molecules (VCAM-1). We also analyzed the integrity of the blood-brain barrier and blood-CSF barrier by staining for tight junction proteins (CLAUDIN5 and ZO-1) and basement membrane proteins (Collagen IV and Laminin). All patients showed some degree of hypoxic/ischemic injury, and several had hemorrhagic infarcts, but we found no evidence of vasculitis. The blood-brain barrier and the blood-CSF barriers were largely intact. We found in a majority of patients microglial activation with microglial nodules and neuronophagia, which were most prominent in the brainstem. In contrast, there was sparse T lymphocyte infiltration in either perivascular regions or brain parenchyma. In parallel, we analyzed whether there was a direct invasion of the SARS-CoV-2 virus into the brain parenchyma via IHC, quantitative reverse-transcriptase PCR, and RNA in situ hybridization (RNAScope). qRT-PCR revealed low to very low viral RNA levels in the majority of brains, levels that were far lower than those in nasal epithelia from the same patients, and did not correlate with neuroinflammation. Furthermore, RNAscope and IHC failed to detect viral RNA or protein in COVID-19 brains. Our analyses suggest that neuroinflammatory findings observed in COVID-19 patients do not result from direct viral infection of the brain parenchyma, but instead are likely a result of systemic inflammation, perhaps with synergistic contribution from hypoxia/ischemia.',
      journalLink:'https://doi.org/10.1002/ana.26180',
      directDownload: '',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/microglial%20activation%20covid19.png',
      width1: 962,
      height1: 471,
      videoSrc:'',
      imageSrc2: '',
      showAbstract: false,
      id:9,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
    {
      title: 'Analysis of COVID-19 Brain Autopsies Reveals That Neuroinflammation is Not Caused by Direct SARS-CoV-2 Infection of the CNS.',
      authors: 'Kiran T. Thakur*, Emily H. Miller*, Michael D. Glendinning*, Osama Al-Dalahmah, Matei A. Banu, Amelia K. Boehme, Alexandra L. Boubour, Samuel S. Bruce, Alexander M. Chong, Jan Claassen, Phyllis L. Faust, Gunnar Hargus, Richard Hickman, Sachin Jambawalikar, Alexander G. Khandji, Carla Y. Kim, Robyn S. Klein, Angela Lignelli-Dipple, Chun-Chieh Lin, Yang Liu, Michael M. Miller, Gul Moonis, Anna S. Nordvig, Morgan L. Prust, William H. Roth, Allison Soung, Kurenai Tanji, Andrew F. Teich, Dritan Agalliu, Anne-Catrin Uhlemann, James E. Goldman, Peter D. Canoll',
      journal: 'Annals of Neurology',
      meeting: 'American Neurological Association',
      year: '2021',
      abstract: 'Background: Many patients suffering from a SARS-CoV-2 infection develop neurological symptoms; however, it is unclear whether they are a consequence of direct viral infection of the CNS or due to secondary sequelae from the virus-induced systemic inflammatory response syndrome.  Methods: In order to understand the mechanisms by which the SARS-CoV-2 systemic infection induces neurological symptoms, we collected brain samples from 41 consecutive COVID-19 patients undergoing autopsy at our medical center from April – June 2020. We characterized the degree of neuroinflammation in these cases by performing histopathological analysis of multiple brain regions and immunohistochemistry (IHC) for cell-specific markers, including macrophages and microglia (CD68 and Iba1), astrocytes (GFAP), lymphocytes (CD3 and CD20), and inflammatory cell adhesion molecules (VCAM-1). We also analyzed the integrity of the blood-brain barrier and blood-CSF barrier by staining for tight junction proteins (CLAUDIN5 and ZO-1) and basement membrane proteins (Collagen IV and Laminin). In parallel, we analyzed whether there was a direct invasion of the SARS-CoV-2 virus into the brain parenchyma via IHC, quantitative reverse-transcriptase PCR (qRT-PCR), and RNA in situ hybridization (RNAScope), targeting both the spike and nucleocapsid regions of the SARS-CoV-2 virus. Results: The mean age was 74 years (38-97 years), 27 patients (66%) were male and 34 (83%) were of Hispanic/Latinx ethnicity. Every patient showed some degree of hypoxic/ischemic injury, and several had hemorrhagic infarcts. The blood-brain and blood-CSF barriers were largely intact. We found in a majority of patients microglial activation (80.5%), most prominently in the brainstem, and often with microglial nodules accompanied by neuronophagia (63.4%). In contrast, there was sparse T lymphocyte infiltration in either perivascular regions or brain parenchyma, and no evidence of vasculitis. qRT-PCR revealed very low viral RNA levels in the majority of brains, which were substantially lower than those in nasal epithelia from the same patients, and when present did not correlate with histopathological evidence of neuroinflammation. Furthermore, RNAscope and IHC failed to detect viral RNA or protein in COVID-19 brains.  Conclusion: Our analyses suggest that neuroinflammatory findings observed in COVID-19 patients do not result from direct viral infection of the brain parenchyma, but instead are likely a result of systemic inflammation, perhaps with synergistic contribution from hypoxia/ischemia.',
      journalLink:'https://doi.org/10.1002/ana.26180',
      directDownload: 'https://storage.googleapis.com/resume_page/content/ANA2021%20COVID19%20poster%20MGlendinning.png',
      imageSrc2: '',
      videoSrc:'',
      imageSrc: 'https://storage.googleapis.com/resume_page/content/ANA2021%20COVID19%20poster%20MGlendinning2.png',
      width1: 2442,
      height1: 1768,
      showAbstract: false,
      id:10,
      isActive: false,
      isExpanded: false,
      isHovered: false,
    },
  ];

  private readonly pageTitle = 'Michael Glendinning - Published Works';

  profileImageUrl = 'https://storage.googleapis.com/resume_page/content/MichaelHeadshot2.jpg';
  isBioExpanded = false;
  bioPreview = 'Click to read more about my background in neuroscience research...';

  constructor(
    @Inject(PLATFORM_ID) private platformId: Object,
    private sanitizer: DomSanitizer,
    private meta: Meta,
    private titleService: Title
  ) {
    this.titleService.setTitle(this.pageTitle);
    this.meta.addTags([
      { name: 'description', content: 'Published works and portfolio of Michael Glendinning' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'robots', content: 'index, follow' }
    ]);
    this.bioText = this.sanitizer.bypassSecurityTrustHtml(`
      <p>
          I graduated from Columbia University in 2017 with a BA in Neuroscience and Behavior in 2017. In my final years at Columbia, I served as a research assistant in an<a href="https://woolleylab.com/" target="_blank" rel="noopener noreferrer"> exceptional neuroscience lab</a> studying vocal learning in songbirds. There, I learned to code in MATLAB and began approaching problems with a computer engineering mindset. This experience introduced me to "big data," machine learning, and signal processing.


      </p>
      <p>
          After graduation, I spent the subsequent 6+ years continuing to do life sciences research in prestigious academic labs, first at
          <a href="https://gradschool.weill.cornell.edu/faculty/heidi-stuhlmann" target="_blank" rel="noopener noreferrer">Weill Cornell Medical College</a>
          and later at
          <a href="https://www.neurology.columbia.edu/research/research-labs/agalliu-lab" target="_blank" rel="noopener noreferrer">Columbia University/NewYork-Presbyterian Hospital</a>.
          I collaborated closely with dozens of scientists and clinicians at the forefront of their disciplines, who trained me to become a discerning and meticulous researcher.

      </p>
      <p>
        <em>I have demonstrated the ability to advance our understanding of a numerous different complex systems, spanning a wide gamut of methods.</em> These published works embody my commitment to continual learning and provide a glimpse into the nature and scope of the research that has occupied my career up until now. I hope they convey the <em>passion and dedication<</em> that drive my work.
      </p>
    `); 
  }

  async ngOnInit(): Promise<void> {
    if (isPlatformBrowser(this.platformId)) {
      this.getCSSVariables();
      this.adjustGrid();
    }
  }

  ngOnDestroy(): void {
    if (this.resizeTimeout) {
      window.clearTimeout(this.resizeTimeout);
    }
  }

  async ngAfterViewInit(): Promise<void> {
    if (isPlatformBrowser(this.platformId)) {
      // Only initialize ScrollReveal once in the browser
      const ScrollReveal = (await import('scrollreveal')).default;
      this.sr = ScrollReveal({
        reset: true,
        distance: '60px',
        duration: 2500,
        delay: 400
      });

      this.sr.reveal('.scroll-reveal', {
        delay: 500,
        origin: 'bottom'
      });

      setTimeout(() => {
        this.resetContainerSizes();
      }, 0);
    }
  }

  getCSSVariables(): void {
    if (isPlatformBrowser(this.platformId)) {
      try {
        const rootStyles = getComputedStyle(document.documentElement);
        
        this.minColumnWidth = parseInt(rootStyles.getPropertyValue('--min-column-width')?.trim() || '400');
        this.gridGap = parseInt(rootStyles.getPropertyValue('--grid-gap')?.trim() || '20');
        this.sidebarWidth = parseInt(rootStyles.getPropertyValue('--sidebar-width')?.trim() || '500');
        this.outerPadding = parseInt(rootStyles.getPropertyValue('--outer-padding')?.trim() || '40');
      } catch (error) {
        console.error('Error getting CSS variables:', error);
        this.setDefaultValues();
      }
    }
  }

  private setDefaultValues(): void {
    this.minColumnWidth = 420;
    this.gridGap = 15;
    this.sidebarWidth = 550;
    this.outerPadding = 30;
  }

  // Apply the line text hover animation to all elements with the 'line-hover' class.
  @HostListener('DOMContentLoaded', ['$event'])
  onDOMContentLoaded(event: Event): void {
    ApplyLineTextHoverAnimation(); // Apply to all elements with the 'line-hover' class.
  }

  @HostListener('window:resize', ['$event'])
  onResize(event: Event): void {
    if (isPlatformBrowser(this.platformId)) {
      if (this.resizeTimeout) {
        window.clearTimeout(this.resizeTimeout);
      }
      this.resizeTimeout = window.setTimeout(() => {
        this.getCSSVariables();
        this.adjustGrid();
      }, 150);
  
      this.resetContainerSizes();
    }
  }
  

  @HostListener('document:keydown.escape')
  handleEscapeKey(): void {
    if (this.isModalOpen) {
      this.closeModal();
    }
  }

  // Variable to track the currently expanded publication ID
  expandedPublicationId: number | null = null;

  // Function to toggle the abstract of a publication
  toggleAbstract(publicationId: number): void {
    if (this.expandedPublicationId === publicationId) {
      // If the clicked publication is already expanded, collapse it
      this.expandedPublicationId = null;
    } else {
      // Set the expandedPublicationId to the clicked publication's ID
      this.expandedPublicationId = publicationId;
    }
  }


  private lockContainerSize(containerRef: ElementRef) {
    if (isPlatformBrowser(this.platformId)) {
      const container = containerRef.nativeElement as HTMLElement;
      const computedStyle = window.getComputedStyle(container);
      const height = computedStyle.height;
      container.style.height = height;
    }
    else {
      console.error('Platform is not browser');
    }
  }

  resetContainerSizes(): void {
    if (isPlatformBrowser(this.platformId)) {
      // Unlock the container sizes
      this.cards.forEach((containerRef) => {
        const container = containerRef.nativeElement as HTMLElement;
        container.style.width = 'auto';
        container.style.height = 'auto';
      });
      this.adjustGrid();
  
      // Re-lock the sizes after content has adjusted
      setTimeout(() => {
        this.cards.forEach((containerRef) => {
          this.lockContainerSize(containerRef);
        });
      }, 0);
    }
  }


  adjustGrid(): void {
    if (isPlatformBrowser(this.platformId)) {
      const windowWidth = window.innerWidth;
      const availableWidth = windowWidth - this.sidebarWidth - (4 * this.outerPadding);
      
      let columns = Math.floor(availableWidth / this.minColumnWidth);
      columns = Math.min(Math.max(columns, 1), 4);
      
      const totalGap = (columns - 1) * this.gridGap;
      const columnWidth = (availableWidth - totalGap) / columns;
      if (columns > 1) {
        this.gridTemplateColumns = `repeat(${columns}, ${columnWidth}px)`;
      } else {
        this.gridTemplateColumns = '100%';
      }
    }
    else {console.error('Platform is not browser');}
  }

  // Optimizes NgFor performance by providing a unique identifier for each item in the list
  trackByFn(index: number, item: Publication): string {
    return item.title; // Using title as unique identifier
  }

  openModal(
    src: string,
    isVideo: boolean = false,
    width?: number,
    height?: number
  ): void {
    console.log('Opening modal with src:', src); // Debugging log
    this.isModalOpen = true;
    this.modalSrc = src;
    this.isVideoModal = isVideo;
    this.modalImageWidth = width;
    this.modalImageHeight = height;

    if (isPlatformBrowser(this.platformId)) {
      document.body.style.overflow = 'hidden';
    } else {
      console.error('Platform is not browser');
    }
  }

  closeModal(): void {
    console.log('Closing modal'); // Debugging log
    this.isModalOpen = false;
    this.modalSrc = '';
    this.isVideoModal = false;
    this.modalImageWidth = undefined;
    this.modalImageHeight = undefined;

    if (isPlatformBrowser(this.platformId)) {
      document.body.style.overflow = 'auto';
    } else {
      console.error('Platform is not browser');
    } 
  }

  handleZoomChange(newZoom: number): void {
  // Implement any actions needed when zoom level changes
  // For example, adjust container sizes or reflow the layout
  if (isPlatformBrowser(this.platformId)) {
    this.resetContainerSizes();
  }
  }

  toggleBio() {
    this.isBioExpanded = !this.isBioExpanded;
  }

  togglePanelActive(pub: Publication) {
    // Deactivate all other publications
    this.articles.forEach(p => {
      if (p !== pub) p.isActive = false;
    });
    pub.isActive = !pub.isActive;
  }

  togglePanelExpanded(pub: Publication, event: Event) {
    event.stopPropagation(); // Prevent panel activation
    pub.isExpanded = !pub.isExpanded;
  }
}