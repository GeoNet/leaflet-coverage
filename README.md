# leaflet-coverage

A [Leaflet](http://leafletjs.com/) plugin for visualizing [coverages](https://en.wikipedia.org/wiki/Coverage_data) (numerical or categorical data varying in space and time) with the help of the [JavaScript Coverage API](https://github.com/Reading-eScience-Centre/coverage-jsapi). Currently, it supports the domain types defined within [CoverageJSON](https://github.com/Reading-eScience-Centre/coveragejson).

Note that to *load* a coverage you have to use another library, depending on which formats you want to support. The only currently known coverage loader that can be used is the [covjson-reader](https://github.com/Reading-eScience-Centre/covjson-reader) for the [CoverageJSON](https://github.com/Reading-eScience-Centre/coveragejson) format.

NOTE: This plugin is in active development and does not support all CoverageJSON domain types yet.

## Example

### Default coverage visualization

```js
var map = L.map('map')
L.tileLayer('http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: 'Map data &copy; <a href="http://www.osm.org">OpenStreetMap</a>'
}).addTo(map)


// default renderers for common domain types
var LayerFactory = L.Coverage.LayerFactory()

var cov = ... // load Coverage object with another library

// TODO should be added like Legend
//  parameterSync: L.Coverage.ParameterSync() // handles palette/legend merging of same-observedProperty/unit parameters
//                                           // only useful for more than one coverage

LayerFactory(cov, {keys: ['salinity']}).on('load', function(e) {
  var covLayer = e.target
  
  new L.Coverage.Controls.Legend(covLayer, {
    id: 'horizontalLegend', // custom HTML template id
    position: 'bottom',
    language: 'de' // preferred language for labels
  }).addTo(map)
  
  if (covLayer.time !== null) {
  	new L.Coverage.Controls.TimeAxis(covLayer).addTo(map)
  }
  if (covLayer.vertical !== null) {
  	new L.Coverage.Controls.VerticalAxis(covLayer).addTo(map)
  }
  
  map.fitBounds(covLayer.getBounds())
}).addTo(map)

// TODO the legend mechanism should be flexible and allow for external implementations
// A typical requirement is to have a single legend for multiple coverages and
// synchronize the coverage palettes, e.g. for a collection of profiles, or profile-grid comparison.
// In some cases a legend is not even desirable, e.g. for certain types of trajectories like GPX tracks, where
// the information is typically put along the track, on hovering, or in popups.
```

TODO need controls for axes (mostly for Grid and maybe profiles)
     is this the right place to implement that?
     Grids can have time/depth, so probably yes, however the actual controls
     should be decoupled since they will be reused for
     "virtual" axis controls (subsetting with Web API)

### Custom visualization

```js
var LayerFactory = L.Coverage.LayerFactory({
  renderer: GPXTrack
})

// alternatively, with more control for different coverage types:
var LayerFactory = L.Coverage.LayerFactory({
  renderers: {
    'http://www.topografix.com/GPX#Track': GPXTrack, // coverage type, precedence over domain types
    'http://www.topografix.com/GPX#Route': GPXRoute,
    'http://coveragejson.org/def#Trajectory': L.Coverage.Renderers.Trajectory // domain type, fall-back for other trajectory coverages
  }
})


LayerFactory(cov, {keys: ['distance', 'elevation', 'heartrate']}).on('load', function(e) {
  var covLayer = e.target
  map.fitBounds(covLayer.getBounds())
}).addTo(map)

```

It's the job of the CoverageLayerFactory to choose the right renderer for a
given Coverage object. Currently this happens based on the `Coverage.type`
and `Coverage.domainType` properties, with the latter being a fall-back if
no renderers for a given `Coverage.type` were found.
If more control is needed, then renderers can be easily invoked manually, or
a more sophisticated factory class may be developed.

A renderer is any class implementing the ILayer interface. The constructor must accept
the Coverage as first argument, and options as second:

```js
// anything implementing ILayer
class GPXTrack extends L.FeatureGroup {
  constructor(cov, options) {
    this.params = options.parameters
  }
  // instead of palettes and legends we could use hovers and popups here
}

class Grid extends L.TileLayer.Canvas {
  constructor(cov, options) {
    this.param = options.parameters[0]
  }
}
```

### Collections

Sometimes it may be necessary to handle a collection of Coverage objects
as a single entity.

TODO write down use cases when this is really needed (probably for profiles)

```js
var LayerFactory = L.Coverage.CollectionLayerFactory()
var covs = ... // many Profiles
LayerFactory(covs, {keys: ['salinity']}).on('load', function(e) {
  var covLayer = e.target
  map.fitBounds(covLayer.getBounds())
}).addTo(map)
```

And similarly for custom renderers:
```js
class ProfileCollection {
  constructor(covs, options) {
    this.param = options.parameters[0]
  }
}
```
where the first constructor argument is an array of Coverage objects.

## Acknowledgments

This library is developed within the [MELODIES project](http://www.melodiesproject.eu).
