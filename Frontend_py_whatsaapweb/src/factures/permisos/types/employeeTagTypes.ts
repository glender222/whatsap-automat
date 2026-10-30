// src/factures/permisos/types/employeeTagTypes.ts

import type { Tag } from '../../mensajeria/types/tagTypes';

export interface EmployeeTag {
  id: string;
  employee_id: string;
  tag_id: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface EmployeeTagWithTag extends EmployeeTag {
  tag: Tag;
}

export interface AssignEmployeeTagRequest {
  employeeId: string;
  tagId: string;
}

export interface RevokeEmployeeTagRequest {
  employeeId: string;
  tagId: string;
}
