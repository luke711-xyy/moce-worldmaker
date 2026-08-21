export const MCP_TOOL_NAMES = [
  'moce_status',
  'moce_get_scene',
  'moce_get_entities',
  'moce_get_selection',
  'moce_render_views',
  'moce_execute_voxel_program',
  'moce_recolor_entities',
  'moce_assemble_entities',
  'moce_undo',
  'moce_redo',
  'moce_local3d_status',
  'moce_generate_from_image',
  'moce_cancel_generation',
  'moce_confirm_generated_model',
] as const

export type McpToolName = typeof MCP_TOOL_NAMES[number]
export type VoxelCoordinate = { x: number; y: number; z: number }
export type VoxelProgram = { transactionId: string; label: string; operations: VoxelOperation[] }

export type VoxelOperation =
  | { type: 'create_primitive'; primitive: 'cuboid' | 'sphere' | 'cylinder' | 'line'; entityId?: string; name?: string; origin: VoxelCoordinate; size?: VoxelCoordinate; radius?: number; height?: number; end?: VoxelCoordinate; materialId?: string }
  | { type: 'add_voxels'; entityId?: string; name?: string; voxels: Array<VoxelCoordinate & { materialId?: string }> }
  | { type: 'subtract_voxels'; entityIds?: string[]; voxels?: VoxelCoordinate[] }
  | { type: 'paint_voxels'; entityIds?: string[]; voxels?: VoxelCoordinate[]; materialId: string }
  | { type: 'extrude_region'; entityId: string; source: VoxelCoordinate[]; axis: 'x' | 'y' | 'z'; delta: number }
  | { type: 'transform_entities'; entityIds: string[]; axis: 'x' | 'y' | 'z'; operation: 'mirror' | 'rotate'; degrees?: 90 | 180 | 270 }
  | { type: 'duplicate_entities'; entityIds: string[]; offset: VoxelCoordinate }
  | { type: 'delete_entities'; entityIds: string[] }
  | { type: 'assemble_entities'; entityIds: string[]; assemblyId?: string; name?: string }

export type BridgeRequest = { type: 'rpc_request'; id: string; method: string; params?: unknown }
export type BridgeResponse = { type: 'rpc_response'; id: string; result?: unknown; error?: { code: string; message: string } }

export const MCP_TOOL_DEFINITIONS = MCP_TOOL_NAMES.map((name) => ({
  name,
  description: `莫测造境本地工具：${name}`,
  inputSchema: { type: 'object', additionalProperties: true },
}))
