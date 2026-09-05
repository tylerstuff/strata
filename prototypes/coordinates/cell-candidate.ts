/** Comparison candidate only. Cells are not part of strata-world-v1 serialization. */
import { validatePosition } from './coordinates.js';
import type { Vec3 } from './coordinates.js';

export const CELL_METERS = 1024;
export interface CellPosition { readonly cell: Vec3; readonly local: Vec3 }

/** Signed int32 cells and binary64 local metres in [-512,512). Carries on +512. */
export function normalizeCell(position: CellPosition): CellPosition {
  validatePosition(position.local);
  if (position.cell.length !== 3) throw new RangeError('cell requires three components');
  const cell = [0, 0, 0];
  const local = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const inputCell = position.cell[axis]!;
    if (!Number.isInteger(inputCell) || inputCell < -2147483648 || inputCell > 2147483647) {
      throw new RangeError('cell must be signed int32');
    }
    const inputLocal = position.local[axis]!;
    let carry = Math.floor(inputLocal / CELL_METERS + 0.5);
    // Compare the original input with exact boundaries before subtracting: a
    // rounded residual can hide nextDown(512) by turning it into exactly -512.
    if (inputLocal < (carry - 0.5) * CELL_METERS) carry--;
    if (inputLocal >= (carry + 0.5) * CELL_METERS) carry++;
    const residual = inputLocal - carry * CELL_METERS;
    const index = inputCell + carry;
    if (index < -2147483648 || index > 2147483647) throw new RangeError('cell carry overflows int32');
    cell[axis] = index === 0 ? 0 : index;
    local[axis] = residual === 0 ? 0 : residual;
  }
  return { cell: cell as unknown as Vec3, local: local as unknown as Vec3 };
}

export function splitPosition(position: Vec3): CellPosition {
  return normalizeCell({ cell: [0, 0, 0], local: position });
}

/** Subtract cells before reconstructing the local difference; no global f32 path. */
export function relativeCell(position: CellPosition, origin: CellPosition): Vec3 {
  const p = normalizeCell(position);
  const o = normalizeCell(origin);
  return [0, 1, 2].map(axis =>
    (p.cell[axis]! - o.cell[axis]!) * CELL_METERS + (p.local[axis]! - o.local[axis]!),
  ) as unknown as Vec3;
}
