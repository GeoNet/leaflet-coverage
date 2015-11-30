import L from 'leaflet'
import ndarray from 'ndarray'
import {linearPalette, scale} from './palettes.js'
import * as arrays from '../util/arrays.js'
import * as rangeutil from '../util/range.js'

const DOMAIN_TYPE = 'http://coveragejson.org/def#Grid'
  
const DEFAULT_CONTINUOUS_PALETTE = () => linearPalette(['#deebf7', '#3182bd']) // blues
const DEFAULT_CATEGORICAL_PALETTE = n => linearPalette(['#e41a1c', '#377eb8', '#4daf4a', '#984ea3'], n)

/**
 * Renderer for Coverages with domain type Grid.
 * 
 * Events fired onto the map:
 * "dataloading" - Data loading has started
 * "dataload" - Data loading has finished (also in case of errors)
 * 
 * Events fired on this layer:
 * "add" - Layer is initialized and is about to be added to the map
 * "remove" - Layer is removed from the map
 * "error" - Error when loading data
 * "paletteChange" - Palette has changed
 * "paletteExtentChange" - Palette extent has changed
 * "axisChange" - Axis coordinate has changed (e.axis === 'time'|'vertical')
 * "remove" - Layer is removed from the map
 * 
 */
export default class Grid extends L.TileLayer.Canvas {
  
  /**
   * The parameter to display must be given as the 'parameter' options property.
   * 
   * Optional time and vertical axis target values can be defined with the 'time' and
   * 'vertical' options properties. The closest values on the respective axes are chosen.
   * 
   * Example: 
   * <pre><code>
   * var cov = ... // get Coverage data
   * var layer = new GridCoverage(cov, {
   *   keys: ['salinity'],
   *   time: new Date('2015-01-01T12:00:00Z'),
   *   vertical: 50,
   *   palette: palettes.get('blues'),
   *   paletteExtent: 'full' // or 'subset' (time/vertical), 'fov' (map field of view), or specific: [-10,10]
   * })
   * </code></pre>
   */
  constructor (cov, options) {
    super()
    if (cov.domainType !== DOMAIN_TYPE) {
      throw new Error('Unsupported domain type: ' + cov.domainType + ', must be: ' + DOMAIN_TYPE)
    }
    this.cov = cov
    this.param = cov.parameters.get(options.keys[0])
    this._axesSubset = { // x and y are not subsetted
        t: {coordPref: options.time},
        z: {coordPref: options.vertical}
    }
    
    if (options.palette) {
      this._palette = options.palette
    } else if (this.param.categories) {
      this._palette = DEFAULT_CATEGORICAL_PALETTE(this.param.categories.length)
    } else {
      this._palette = DEFAULT_CONTINUOUS_PALETTE()
    }
    
    if (this.param.categories && this.param.categories.length !== this._palette.steps) {
      throw new Error('Categorical palettes must match the number of categories of the parameter')
    }
    
    if (this.param.categories) {
      if (options.paletteExtent) {
        throw new Error('paletteExtent cannot be given for categorical parameters')
      }
    } else {
      if (options.paletteExtent === undefined) {
        this._paletteExtent = 'subset'
      } else if (Array.isArray(options.paletteExtent) || ['subset', 'fov'].indexOf(options.paletteExtent) !== -1) {
        this._paletteExtent = options.paletteExtent
      } else {
        throw new Error('paletteExtent must either be a 2-element array, one of "subset" or "fov", or be omitted')
      }
    }
    
    switch (options.redraw) {
    case 'manual': this._autoRedraw = false; break
    case undefined:
    case 'onchange': this._autoRedraw = true; break
    default: throw new Error('redraw must be "onchange", "manual", or omitted (defaults to "onchange")')
    }
  }
  
  onAdd (map) {
    // "loading" and "load" events are provided by the underlying TileLayer class
    
    this._map = map
    map.fire('dataloading') // for supporting loading spinners
    this.cov.loadDomain()
      .then(domain => {
        this.domain = domain
      })
      .then(this._subsetByCoordinatePreference)
      .then(() => this.subsetCov.loadRange(this.param.key))
      .then(subsetRange => {
        this.subsetRange = subsetRange
        if (!this.param.categories) {
          this._updatePaletteExtent(this._paletteExtent)
        }
        this.fire('add')
        super.onAdd(map)
        map.fire('dataload')
      })
      .catch(e => {
        console.error(e)
        this.fire('error', e)
        
        map.fire('dataload')
      })
  }
  
  onRemove (map) {
    delete this._map
    this.fire('remove')
    super.onRemove(map)
  }
    
  getBounds () {
    let bbox
    if (this.cov.bbox) {
      bbox = this.cov.bbox
    } else if (this._isRectilinearGeodeticDomainGrid()) {
      bbox = this._getDomainBbox()
    } else {
      return
    }
    let southWest = L.latLng(bbox[1], bbox[0])
    let northEast = L.latLng(bbox[3], bbox[2])
    let bounds = new L.LatLngBounds(southWest, northEast)
    return bounds
  }
  
  /**
   * Subsets the temporal and vertical axes based on the _axesSubset.*.coordPref property,
   * which is regarded as a preference and does not have to exactly match a coordinate.
   * 
   * The return value is a promise that succeeds with an empty result and
   * sets this.subsetCov to the subsetted coverage.
   * The subsetting always fixes a single time and vertical slice, choosing the first
   * axis value if no preference was given.
   * 
   * After calling this method, _axesSubset.*.idx and _axesSubset.*.coord have
   * values from the actual axes.
   */
  _subsetByCoordinatePreference () {
    
    /**
     * Return the index of the coordinate value closest to the given value
     * within the given axis. Supports ascending and descending axes.
     * If the axis does not exist, then undefined is returned.
     */
    let getClosestIndex = (axis, val) => {
      if (!this.domain.axes.has(axis)) {
        return
      }
      let vals = this.domain.axes.get(axis).values
      let idx = arrays.indexOfNearest(vals, val)
      return idx
    }
    
    for (let axis of Object.keys(this._axesSubset)) {
      let ax = this._axesSubset[axis]
      if (ax.coordPref == undefined && this.domain.axes.has(axis)) { // == also handles null
        ax.idx = 0
      } else {
        ax.idx = getClosestIndex(axis, ax.coordPref)
      }
      ax.coord = this.domain.axes.has(axis) ? this.domain.axes.get(axis).values[ax.idx] : null
    }
    
    return this.cov.subsetByIndex({t: this._axesSubset.t.idx, z: this._axesSubset.z.idx})
      .then(subsetCov => {
        this.subsetCov = subsetCov
      })
  }
  
  get parameter () {
    return this.param
  }
  
  /**
   * Sets the currently active time to the one closest to the given Date object.
   * This has no effect if the grid has no time axis.
   */
  set time (val) {
    if (!this.domain.axes.has('t')) {
      throw new Error('No time axis found')
    }
    let old = this.time
    this._axesSubset.t.coordPref = val
    this._subsetByCoordinatePreference().then(() => {
      this._doAutoRedraw()
      if (old !== this.time) {
        this.fire('axisChange', {axis: 'time'})
      }
    })
  }
  
  /**
   * The currently active time on the temporal axis as Date object, 
   * or null if the grid has no time axis.
   */
  get time () {
    return this._axesSubset.t.coord
  }
  
  /**
   * Sets the currently active vertical coordinate to the one closest to the given value.
   * This has no effect if the grid has no vertical axis.
   */
  set vertical (val) {
    if (!this.domain.axes.has('z')) {
      throw new Error('No vertical axis found')
    }
    let old = this.vertical
    this._axesSubset.z.coordPref = val
    this._subsetByCoordinatePreference().then(() => {
      this._doAutoRedraw()
      if (old !== this.vertical) {
        this.fire('axisChange', {axis: 'vertical'})
      } 
    })  
  }
  
  /**
   * The currently active vertical coordinate as a number, 
   * or null if the grid has no vertical axis.
   */
  get vertical () {
    return this._axesSubset.z.coord
  }
   
  set palette (p) {
    this._palette = p
    this._doAutoRedraw()
    this.fire('paletteChange')
  }
  
  get palette () {
    return this._palette
  }
  
  _updatePaletteExtent (extent) {
    if (Array.isArray(extent) && extent.length === 2) {
      this._paletteExtent = extent
      return
    } 

    let range
        
    if (extent === 'subset') {
      // scan the current subset for min/max values
      range = this.subsetRange
      
    } else if (extent === 'fov') {
      // scan the values that are currently in field of view on the map for min/max
      // this implies using the current subset
      let bounds = this._map.getBounds()

      // TODO implement
      throw new Error('NOT IMPLEMENTED YET')      
    } else {
      throw new Error('Unknown extent specification: ' + extent)
    }
    
    this._paletteExtent = rangeutil.minMax(range)
  }
  
  set paletteExtent (extent) {
    if (this.param.categories) {
      throw new Error('Cannot set palette extent for categorical parameters')
    }
    this._updatePaletteExtent(extent)
    this._doAutoRedraw()
    this.fire('paletteExtentChange')
  }
  
  get paletteExtent () {
    return this._paletteExtent
  }
    
  drawTile (canvas, tilePoint, zoom) {
    let ctx = canvas.getContext('2d')
    let tileSize = this.options.tileSize
    
    let imgData = ctx.getImageData(0, 0, tileSize, tileSize)
    // Uint8ClampedArray, 1-dimensional, in order R,G,B,A,R,G,B,A,... row-major
    let rgba = ndarray(imgData.data, [tileSize, tileSize, 4])
    
    // projection coordinates of top left tile pixel
    let start = tilePoint.multiplyBy(tileSize)
    let startX = start.x
    let startY = start.y
    
    let palette = this.palette
    let {red, green, blue} = this.palette
    let paletteExtent = this.paletteExtent
    
    let doSetPixel = (tileY, tileX, idx) => {
      rgba.set(tileY, tileX, 0, red[idx])
      rgba.set(tileY, tileX, 1, green[idx])
      rgba.set(tileY, tileX, 2, blue[idx])
      rgba.set(tileY, tileX, 3, 255)
    }
    
    let setPixel
    if (this.param.categories) {
      // categorical parameter
      let valIdxMap = new Map()
      for (let idx=0; idx < this.param.categories.length; idx++) {
        let cat = this.param.categories[idx]
        if (cat.value) {
          valIdxMap.set(cat.value, idx)
        } else {
          for (let val of cat.values) {
            valIdxMap.set(val, idx)
          }
        }
      }
      setPixel = (tileY, tileX, val) => {
        if (val === null || !valIdxMap.has(val)) return
        let idx = valIdxMap.get(val)
        doSetPixel(tileY, tileX, idx)
      }
    } else {
      // continuous parameter
      setPixel = (tileY, tileX, val) => {
        if (val === null) return
        let idx = scale(val, palette, paletteExtent)
        doSetPixel(tileY, tileX, idx)
      }
    }
    
    let vals = this.subsetRange.get
    
    if (this._isRectilinearGeodeticDomainGrid()) {
      if (this._isProjectedCoverageCRS()) {
        // unproject to lon/lat first
        // TODO how can we do that? this means adding a dependency to proj4js!
        // should probably be made optional since this is an edge case
        throw new Error('NOT IMPLEMENTED YET')
      }
      if (this._isRectilinearGeodeticMap()) {
        // here we can apply heavy optimizations
        this._drawRectilinearGeodeticMapProjection(setPixel, tileSize, startX, startY, vals)
      } else {
        // this is for any random map projection
        // here we have to unproject each map pixel individually and find the matching domain coordinates
        this._drawAnyMapProjection(setPixel, tileSize, startX, startY, vals)
      }      
    } else {
      if (true /*map CRS == domain CRS*/) { // TODO implement
        throw new Error('NOT IMPLEMENTED YET')
      } else {
        // here we would have to reproject the coverage
        // since this is not feasible in browsers, we just throw an error
        throw new Error('The map CRS must match the Coverage CRS ' +
                        'if the latter cannot be mapped to a rectilinear geodetic grid')
      }
    }
    
    ctx.putImageData(imgData, 0, 0)    
  }
  
  /**
   * Derives the bounding box of the x,y axes in CRS coordinates.
   * @returns {Array} [xmin,ymin,xmax,ymax]
   */
  _getDomainBbox () {
    let x = this.domain.axes.get('x').values
    let y = this.domain.axes.get('y').values
    
    // TODO use bounds if they are supplied
    let xend = x.length - 1
    let yend = y.length - 1
    let [xmin,xmax] = [x[0], x[xend]]
    let [ymin,ymax] = [y[0], y[yend]]
    // TODO only enlarge when bounds haven't been used above
    if (x.length > 1) {
      xmin -= Math.abs(x[0] - x[1]) / 2
      xmax += Math.abs(x[xend] - x[xend - 1]) / 2
    }
    if (y.length > 1) {
      ymin -= Math.abs(y[0] - y[1]) / 2
      ymax += Math.abs(y[yend] - y[yend - 1]) / 2
    }
    if (xmin > xmax) {
      [xmin,xmax] = [xmax,xmin]
    }
    if (ymin > ymax) {
      [ymin,ymax] = [ymax,ymin]
    }
    return [xmin,ymin,xmax,ymax]
  }
  
  /**
   * Draws a geodetic rectilinear domain grid on a map with arbitrary projection.
   * 
   * @param {Function} setPixel A function with parameters (y,x,val) which 
   *                            sets the color of a pixel on a tile.
   * @param {Integer} tileSize Size of a tile in pixels.
   * @param {Integer} startX
   * @param {Integer} startY
   * @param {ndarray} vals Range values.
   */
  _drawAnyMapProjection (setPixel, tileSize, startX, startY, vals) {
    // usable for any map projection, but computationally more intensive
    // there are two hotspots in the loops: map.unproject and indexOfNearest

    let map = this._map
    let x = this.domain.axes.get('x').values
    let y = this.domain.axes.get('y').values
    let bbox = this._getDomainBbox()
    let lonRange = [bbox[0], bbox[0] + 360]
    
    for (let tileX = 0; tileX < tileSize; tileX++) {
      for (let tileY = 0; tileY < tileSize; tileY++) {
        let {lat,lon} = map.unproject(L.point(startX + tileX, startY + tileY))

        // we first check whether the tile pixel is outside the domain bounding box
        // in that case we skip it as we do not want to extrapolate
        if (lat < bbox[1] || lat > bbox[3]) {
          continue
        }

        lon = wrapLongitude(lon, lonRange)
        if (lon < bbox[0] || lon > bbox[2]) {
          continue
        }

        // now we find the closest grid cell using simple binary search
        // for finding the closest latitude/longitude we use a simple binary search
        // (as there is no discontinuity)
        let iLat = arrays.indexOfNearest(y, lat)
        let iLon = arrays.indexOfNearest(x, lon)

        setPixel(tileY, tileX, vals({y: iLat, x: iLon}))
      }
    }
  }
  
  /**
   * Draws a geodetic rectilinear domain grid on a map whose grid is, or can be directly
   * mapped to, a geodetic rectilinear grid.
   */
  _drawRectilinearGeodeticMapProjection (setPixel, tileSize, startX, startY, vals) {
    // optimized version for map projections that are equal to a rectilinear geodetic grid
    // this can be used when lat and lon can be computed independently for a given pixel

    let map = this._map
    let x = this.domain.axes.get('x').values
    let y = this.domain.axes.get('y').values
    let bbox = this._getDomainBbox()
    let lonRange = [bbox[0], bbox[0] + 360]
    
    var latCache = new Float64Array(tileSize)
    var iLatCache = new Uint32Array(tileSize)
    for (let tileY = 0; tileY < tileSize; tileY++) {
      var lat = map.unproject(L.point(startX, startY + tileY)).lat
      latCache[tileY] = lat
      // find the index of the closest latitude in the grid using simple binary search
      iLatCache[tileY] = arrays.indexOfNearest(y, lat)
    }

    for (let tileX = 0; tileX < tileSize; tileX++) {
      let lon = map.unproject(L.point(startX + tileX, startY)).lng
      lon = wrapLongitude(lon, lonRange)
      if (lon < bbox[0] || lon > bbox[2]) {
        continue
      }

      // find the index of the closest longitude in the grid using simple binary search
      // (as there is no discontinuity)
      let iLon = arrays.indexOfNearest(x, lon)

      for (let tileY = 0; tileY < tileSize; tileY++) {
        // get geographic coordinates of tile pixel
        let lat = latCache[tileY]

        // we first check whether the tile pixel is outside the domain bounding box
        // in that case we skip it as we do not want to extrapolate
        if (lat < bbox[1] || lat > bbox[3]) {
          continue
        }

        let iLat = iLatCache[tileY]

        setPixel(tileY, tileX, vals({y: iLat, x: iLon}))
      }
    }
  }
  
  /**
   * Return true if the map projection grid can be mapped to a rectilinear
   * geodetic grid. For that, it must satisfy:
   * for all x, there is a longitude lon, for all y, unproject(x,y).lon = lon
   * for all y, there is a latitude lat, for all x, unproject(x,y).lat = lat
   * 
   * Returns false if this is not the case or unknown.
   */
  _isRectilinearGeodeticMap () {
    let crs = this._map.options.crs
    // these are the ones included in Leaflet
    let recti = [L.CRS.EPSG3857, L.CRS.EPSG4326, L.CRS.EPSG3395, L.CRS.Simple]
    let isRecti = recti.indexOf(crs) !== -1
    // TODO for unknown ones, how do we test that?
    return isRecti
  }
  
  /**
   * Same as _isRectilinearGeodeticMap but for the coverage CRS.
   */
  _isRectilinearGeodeticDomainGrid () {
    // FIXME 
    if (!this.domain.crs) {
      // defaults to CRS84 if not given
      return true
    }
    // TODO add other common ones or somehow detect it automatically
    let recti = ['http://www.opengis.net/def/crs/OGC/1.3/CRS84']
    return recti.some(r => this.domain.crs === r)
  }
  
  /**
   * Whether the CRS of the coverage is a projected one, meaning
   * that x and y are not geographic coordinates (lon/lat) but easting and northing
   * which have to be converted to geographic coordinates.
   */
  _isProjectedCoverageCRS () {
    // FIXME 
    if (!this.domain.crs) {
      return false
    }
    let geographic = ['http://www.opengis.net/def/crs/OGC/1.3/CRS84']
    return !geographic.some(uri => this.domain.crs === uri)
  }
  
  _doAutoRedraw () {
    // we check getContainer() to prevent errors when trying to redraw when the layer has not
    // fully initialized yet
    if (this._autoRedraw && this.getContainer()) {
      this.redraw()
    }
  }
  
}

function wrapLongitude (lon, range) {
  return wrapNum(lon, range, true)
}

//stolen from https://github.com/Leaflet/Leaflet/blob/master/src/core/Util.js
//doesn't exist in current release (0.7.3)
function wrapNum (x, range, includeMax) {
  var max = range[1]
  var min = range[0]
  var d = max - min
  return x === max && includeMax ? x : ((x - min) % d + d) % d + min
}
