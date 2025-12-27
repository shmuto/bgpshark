import { useState, useCallback, useRef, useEffect } from 'react'

interface PaneSizes {
  packets: number
  detail: number
  neighbors: number
}

interface UseResizablePanesOptions {
  panes: { packets: boolean; detail: boolean; neighbors: boolean }
  containerRef: React.RefObject<HTMLDivElement | null>
}

export function useResizablePanes({ panes, containerRef }: UseResizablePanesOptions) {
  // Store sizes as percentages (0-100)
  const [sizes, setSizes] = useState<PaneSizes>({
    packets: 33.33,
    detail: 33.33,
    neighbors: 33.34,
  })

  const dragState = useRef<{
    dragging: boolean
    dividerIndex: number
    startX: number
    startSizes: PaneSizes
  } | null>(null)

  // Get visible panes in order
  const getVisiblePanes = useCallback((): (keyof PaneSizes)[] => {
    const visible: (keyof PaneSizes)[] = []
    if (panes.packets) visible.push('packets')
    if (panes.detail) visible.push('detail')
    if (panes.neighbors) visible.push('neighbors')
    return visible
  }, [panes])

  // Calculate actual sizes for visible panes
  const getActualSizes = useCallback((): Record<keyof PaneSizes, number> => {
    const visible = getVisiblePanes()
    if (visible.length === 0) {
      return { packets: 0, detail: 0, neighbors: 0 }
    }
    if (visible.length === 1) {
      return {
        packets: panes.packets ? 100 : 0,
        detail: panes.detail ? 100 : 0,
        neighbors: panes.neighbors ? 100 : 0,
      }
    }

    // Normalize sizes for visible panes
    const totalSize = visible.reduce((sum, key) => sum + sizes[key], 0)
    const result: Record<keyof PaneSizes, number> = { packets: 0, detail: 0, neighbors: 0 }

    for (const key of visible) {
      result[key] = (sizes[key] / totalSize) * 100
    }

    return result
  }, [panes, sizes, getVisiblePanes])

  const handleMouseDown = useCallback(
    (dividerIndex: number) => (e: React.MouseEvent) => {
      e.preventDefault()
      dragState.current = {
        dragging: true,
        dividerIndex,
        startX: e.clientX,
        startSizes: { ...sizes },
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sizes]
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current?.dragging || !containerRef.current) return

      const container = containerRef.current
      const containerRect = container.getBoundingClientRect()
      const containerWidth = containerRect.width

      const deltaX = e.clientX - dragState.current.startX
      const deltaPercent = (deltaX / containerWidth) * 100

      const visible = getVisiblePanes()
      const { dividerIndex, startSizes } = dragState.current

      // The divider is between visible[dividerIndex] and visible[dividerIndex + 1]
      const leftPane = visible[dividerIndex]
      const rightPane = visible[dividerIndex + 1]

      if (!leftPane || !rightPane) return

      const minSize = 15 // Minimum 15% per pane
      const leftStart = startSizes[leftPane]
      const rightStart = startSizes[rightPane]

      let newLeft = leftStart + deltaPercent
      let newRight = rightStart - deltaPercent

      // Enforce minimum sizes
      if (newLeft < minSize) {
        newLeft = minSize
        newRight = leftStart + rightStart - minSize
      }
      if (newRight < minSize) {
        newRight = minSize
        newLeft = leftStart + rightStart - minSize
      }

      setSizes((prev) => ({
        ...prev,
        [leftPane]: newLeft,
        [rightPane]: newRight,
      }))
    }

    const handleMouseUp = () => {
      if (dragState.current?.dragging) {
        dragState.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [containerRef, getVisiblePanes])

  // Reset sizes when pane visibility changes
  useEffect(() => {
    const visible = getVisiblePanes()
    if (visible.length > 0) {
      const equalSize = 100 / visible.length
      setSizes((prev) => {
        const newSizes = { ...prev }
        for (const key of visible) {
          newSizes[key] = equalSize
        }
        return newSizes
      })
    }
  }, [panes.packets, panes.detail, panes.neighbors, getVisiblePanes])

  return {
    getActualSizes,
    getVisiblePanes,
    handleMouseDown,
    isDragging: () => dragState.current?.dragging ?? false,
  }
}
