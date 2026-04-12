import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./home').then((m) => m.Home) },
  { path: 'about', loadComponent: () => import('./about').then((m) => m.About) },
  { path: '**', redirectTo: '' },
];
