var vg = window.vg || {};
// Expose to global scope
window.vg = vg;

// Constants
vg.VERSION = "2.0.0";
vg.PI = Math.PI;
vg.TAU = Math.PI * 2;
vg.DEG_TO_RAD = Math.PI / 180;
vg.RAD_TO_DEG = 180 / Math.PI;
vg.SQRT3 = Math.sqrt(3);
vg.TILE = "tile";
vg.HEX = "hex";

// --------------------
// File: Tools.js
// --------------------
vg.Tools = {
    clamp: function(val, min, max) {
        return Math.max(min, Math.min(max, val));
    },
    sign: function(val) {
        return val && val / Math.abs(val);
    },
    /**
     * If one value is passed, returns a value between -val and val;
     * else returns a value between min and max.
     */
    random: function(min, max) {
        if (arguments.length === 1) {
            return (Math.random() * min) - (min * 0.5);
        }
        return Math.random() * (max - min) + min;
    },
    // from min to (and including) max
    randomInt: function(min, max) {
        if (arguments.length === 1) {
            return (Math.random() * min) - (min * 0.5) | 0;
        }
        return (Math.random() * (max - min + 1) + min) | 0;
    },
    normalize: function(v, min, max) {
        return (v - min) / (max - min);
    },
    getShortRotation: function(angle) {
        angle %= this.TAU;
        if (angle > this.PI) {
            angle -= this.TAU;
        } else if (angle < -this.PI) {
            angle += this.TAU;
        }
        return angle;
    },
    generateID: function() {
        return Math.random().toString(36).slice(2) + Date.now();
    },
    isPlainObject: function(obj) {
        if (typeof(obj) !== 'object' || obj.nodeType || obj === obj.window) {
            return false;
        }
        try {
            if (obj.constructor && !Object.prototype.hasOwnProperty.call(obj.constructor.prototype, 'isPrototypeOf')) {
                return false;
            }
        } catch (err) {
            return false;
        }
        return true;
    },
    merge: function(target, src) {
        var self = this, array = Array.isArray(src);
        var dst = array ? [] : {};
        if (array) {
            target = target || [];
            dst = dst.concat(target);
            src.forEach(function(e, i) {
                if (typeof dst[i] === 'undefined') {
                    dst[i] = e;
                } else if (self.isPlainObject(e)) {
                    dst[i] = self.merge(target[i], e);
                } else {
                    if (target.indexOf(e) === -1) {
                        dst.push(e);
                    }
                }
            });
            return dst;
        }
        if (target && self.isPlainObject(target)) {
            Object.keys(target).forEach(function(key) {
                dst[key] = target[key];
            });
        }
        Object.keys(src).forEach(function(key) {
            if (!src[key] || !self.isPlainObject(src[key])) {
                dst[key] = src[key];
            } else {
                if (!target[key]) {
                    dst[key] = src[key];
                } else {
                    dst[key] = self.merge(target[key], src[key]);
                }
            }
        });
        return dst;
    },
    now: function() {
        return window.performance.now();
    },
    empty: function(node) {
        while (node.lastChild) {
            node.removeChild(node.lastChild);
        }
    },
    radixSort: function(arr, idxBegin, idxEnd, bit) {
        idxBegin = idxBegin || 0;
        idxEnd = idxEnd || arr.length;
        bit = bit || 31;
        if (idxBegin >= (idxEnd - 1) || bit < 0) {
            return;
        }
        var idx = idxBegin;
        var idxOnes = idxEnd;
        var mask = 0x1 << bit;
        while (idx < idxOnes) {
            if (arr[idx] & mask) {
                --idxOnes;
                var tmp = arr[idx];
                arr[idx] = arr[idxOnes];
                arr[idxOnes] = tmp;
            } else {
                ++idx;
            }
        }
        this.radixSort(arr, idxBegin, idxOnes, bit - 1);
        this.radixSort(arr, idxOnes, idxEnd, bit - 1);
    },
    randomizeRGB: function(base, range) {
        var rgb = base.split(',');
        var color = 'rgb(';
        var i, c;
        range = this.randomInt(range);
        for (i = 0; i < 3; i++) {
            c = parseInt(rgb[i]) + range;
            if (c < 0) c = 0;
            else if (c > 255) c = 255;
            color += c + ',';
        }
        color = color.substring(0, color.length - 1) + ')';
        return color;
    },
    getJSON: function(config) {
        var xhr = new XMLHttpRequest();
        var cache = typeof config.cache === 'undefined' ? false : config.cache;
        var uri = cache ? config.url : config.url + '?t=' + Math.floor(Math.random() * 10000) + Date.now();
        xhr.onreadystatechange = function() {
            if (this.status === 200) {
                var json = null;
                try {
                    json = JSON.parse(this.responseText);
                } catch (err) {
                    return;
                }
                config.callback.call(config.scope || null, json);
                return;
            } else if (this.status !== 0) {
                console.warn('[Tools.getJSON] Error: ' + this.status + ' (' + this.statusText + ') :: ' + config.url);
            }
        };
        xhr.open('GET', uri, true);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send('');
    }
};

vg.Tools.TAU = Math.PI * 2;
vg.Tools.PI = Math.PI;

// --------------------
// File: LinkedList.js
// --------------------
(function() {
    var LinkedListNode = function() {
        this.obj = null;
        this.next = null;
        this.prev = null;
        this.free = true;
    };

    var LinkedList = function() {
        this.first = null;
        this.last = null;
        this.length = 0;
        this.objToNodeMap = {}; // quick lookup by object uniqueID
        this.uniqueID = Date.now() + '' + Math.floor(Math.random() * 1000);
        this.sortArray = [];
    };

    LinkedList.generateID = function() {
        return Math.random().toString(36).slice(2) + Date.now();
    };

    LinkedList.prototype = {
        getNode: function(obj) {
            return this.objToNodeMap[obj.uniqueID];
        },
        addNode: function(obj) {
            var node = new LinkedListNode();
            if (!obj.uniqueID) {
                try {
                    obj.uniqueID = LinkedList.generateID();
                } catch (err) {
                    console.error('[LinkedList.addNode] object is immutable.');
                    return null;
                }
            }
            node.obj = obj;
            node.free = false;
            this.objToNodeMap[obj.uniqueID] = node;
            return node;
        },
        swapObjects: function(node, newObj) {
            this.objToNodeMap[node.obj.uniqueID] = null;
            this.objToNodeMap[newObj.uniqueID] = node;
            node.obj = newObj;
        },
        add: function(obj) {
            var node = this.objToNodeMap[obj.uniqueID];
            if (!node) {
                node = this.addNode(obj);
            } else {
                if (node.free === false) return;
                node.obj = obj;
                node.free = false;
                node.next = null;
                node.prev = null;
            }
            if (!this.first) {
                this.first = node;
                this.last = node;
                node.next = null;
                node.prev = null;
            } else {
                this.last.next = node;
                node.prev = this.last;
                this.last = node;
                node.next = null;
            }
            this.length++;
        },
        has: function(obj) {
            return !!this.objToNodeMap[obj.uniqueID];
        },
        moveUp: function(obj) {
            var c = this.getNode(obj);
            if (!c) throw "Object not in list";
            if (!c.prev) return;
            var b = c.prev;
            var a = b.prev;
            if (c === this.last) this.last = b;
            var oldCNext = c.next;
            if (a) a.next = c;
            c.next = b;
            c.prev = b.prev;
            b.next = oldCNext;
            b.prev = c;
            if (this.first === b) this.first = c;
        },
        moveDown: function(obj) {
            var b = this.getNode(obj);
            if (!b) throw "Object not in list";
            if (!b.next) return;
            var c = b.next;
            this.moveUp(c.obj);
            if (this.last === c) this.last = b;
        },
        sort: function(compare) {
            var sortArray = this.sortArray;
            var node = this.first;
            sortArray.length = 0;
            while (node) {
                sortArray.push(node.obj);
                node = node.next;
            }
            this.clear();
            sortArray.sort(compare);
            for (var i = 0; i < sortArray.length; i++) {
                this.add(sortArray[i]);
            }
        },
        remove: function(obj) {
            var node = this.getNode(obj);
            if (!node || node.free) return false;
            if (node.prev) node.prev.next = node.next;
            if (node.next) node.next.prev = node.prev;
            if (!node.prev) this.first = node.next;
            if (!node.next) this.last = node.prev;
            node.free = true;
            node.prev = null;
            node.next = null;
            this.length--;
            return true;
        },
        shift: function() {
            var node = this.first;
            if (this.length === 0) return null;
            this.first = node.next;
            if (!node.next) this.last = null;
            node.free = true;
            node.prev = null;
            node.next = null;
            this.length--;
            return node.obj;
        },
        pop: function() {
            var node = this.last;
            if (this.length === 0) return null;
            this.last = node.prev;
            if (!node.prev) this.first = null;
            node.free = true;
            node.prev = null;
            node.next = null;
            this.length--;
            return node.obj;
        },
        concat: function(list) {
            var node = list.first;
            while (node) {
                this.add(node.obj);
                node = node.next;
            }
        },
        clear: function() {
            var next = this.first;
            while (next) {
                next.free = true;
                next = next.next;
            }
            this.first = null;
            this.length = 0;
        },
        dispose: function() {
            var next = this.first;
            while (next) {
                next.obj = null;
                next = next.next;
            }
            this.first = null;
            this.objToNodeMap = null;
        },
        dump: function(msg) {
            console.log('====================' + msg + '=====================');
            var a = this.first;
            while (a) {
                console.log("{" + a.obj.toString() + "} previous=" + (a.prev ? a.prev.obj : "NULL"));
                a = a.next;
            }
            console.log("===================================");
            console.log("Last: {" + (this.last ? this.last.obj : 'NULL') + "} First: {" + (this.first ? this.first.obj : 'NULL') + "}");
        }
    };

    LinkedList.prototype.constructor = LinkedList;
    vg.LinkedList = LinkedList;
}());

// --------------------
// File: Signal.js
// --------------------
(function() {
    var SignalBinding = function(signal, listener, isOnce, listenerContext, priority) {
        this._listener = listener;
        this.isOnce = isOnce;
        this.context = listenerContext;
        this.signal = signal;
        this._priority = priority || 0;
    };

    SignalBinding.prototype = {
        active: true,
        params: null,
        execute: function(paramsArr) {
            var handlerReturn, params;
            if (this.active && !!this._listener) {
                params = this.params ? this.params.concat(paramsArr) : paramsArr;
                handlerReturn = this._listener.apply(this.context, params);
                if (this.isOnce) {
                    this.detach();
                }
            }
            return handlerReturn;
        },
        detach: function() {
            return this.isBound() ? this.signal.remove(this._listener, this.context) : null;
        },
        isBound: function() {
            return (!!this.signal && !!this._listener);
        },
        _destroy: function() {
            delete this.signal;
            delete this._listener;
            delete this.context;
        },
        toString: function() {
            return '[SignalBinding isOnce:' + this.isOnce + ', isBound:' + this.isBound() + ', active:' + this.active + ']';
        }
    };

    SignalBinding.prototype.constructor = SignalBinding;

    var Signal = function() {
        this._bindings = [];
        this._prevParams = null;
        var self = this;
        this.dispatch = function() {
            Signal.prototype.dispatch.apply(self, arguments);
        };
    };

    Signal.prototype = {
        memorize: false,
        _shouldPropagate: true,
        active: true,
        validateListener: function(listener, fnName) {
            if (typeof listener !== 'function') {
                throw new Error('Signal: listener is a required param of ' + fnName + '() and should be a Function.');
            }
        },
        _registerListener: function(listener, isOnce, listenerContext, priority) {
            var prevIndex = this._indexOfListener(listener, listenerContext);
            var binding;
            if (prevIndex !== -1) {
                binding = this._bindings[prevIndex];
                if (binding.isOnce !== isOnce) {
                    throw new Error('Cannot add' + (isOnce ? '' : 'Once') + '() then add' + (!isOnce ? '' : 'Once') + '() the same listener without removing it first.');
                }
            } else {
                binding = new SignalBinding(this, listener, isOnce, listenerContext, priority);
                this._addBinding(binding);
            }
            if (this.memorize && this._prevParams) {
                binding.execute(this._prevParams);
            }
            return binding;
        },
        _addBinding: function(binding) {
            var n = this._bindings.length;
            do {
                n--;
            } while (this._bindings[n] && binding._priority <= this._bindings[n]._priority);
            this._bindings.splice(n + 1, 0, binding);
        },
        _indexOfListener: function(listener, context) {
            var n = this._bindings.length, cur;
            while (n--) {
                cur = this._bindings[n];
                if (cur._listener === listener && cur.context === context) {
                    return n;
                }
            }
            return -1;
        },
        has: function(listener, context) {
            return this._indexOfListener(listener, context) !== -1;
        },
        add: function(listener, listenerContext, priority) {
            this.validateListener(listener, 'add');
            return this._registerListener(listener, false, listenerContext, priority);
        },
        addOnce: function(listener, listenerContext, priority) {
            this.validateListener(listener, 'addOnce');
            return this._registerListener(listener, true, listenerContext, priority);
        },
        remove: function(listener, context) {
            this.validateListener(listener, 'remove');
            var i = this._indexOfListener(listener, context);
            if (i !== -1) {
                this._bindings[i]._destroy();
                this._bindings.splice(i, 1);
            }
            return listener;
        },
        removeAll: function(context) {
            if (typeof context === 'undefined') { context = null; }
            var n = this._bindings.length;
            while (n--) {
                if (context) {
                    if (this._bindings[n].context === context) {
                        this._bindings[n]._destroy();
                        this._bindings.splice(n, 1);
                    }
                } else {
                    this._bindings[n]._destroy();
                }
            }
            if (!context) {
                this._bindings.length = 0;
            }
        },
        getNumListeners: function() {
            return this._bindings.length;
        },
        halt: function() {
            this._shouldPropagate = false;
        },
        dispatch: function() {
            if (!this.active) {
                return;
            }
            var paramsArr = Array.prototype.slice.call(arguments);
            var n = this._bindings.length, bindings;
            if (this.memorize) {
                this._prevParams = paramsArr;
            }
            if (!n) {
                return;
            }
            bindings = this._bindings.slice();
            this._shouldPropagate = true;
            do {
                n--;
            } while (bindings[n] && this._shouldPropagate && bindings[n].execute(paramsArr) !== false);
        },
        forget: function() {
            this._prevParams = null;
        },
        dispose: function() {
            this.removeAll();
            delete this._bindings;
            delete this._prevParams;
        },
        toString: function() {
            return '[Signal active:' + this.active + ' numListeners:' + this.getNumListeners() + ']';
        }
    };

    Signal.prototype.constructor = Signal;
    vg.Signal = Signal;
}());

// --------------------
// File: Loader.js
// --------------------
vg.Loader = {
    manager: null,
    imageLoader: null,
    crossOrigin: false,
    renderer: null, 
	
    init: function(crossOrigin, renderer) {
        this.crossOrigin = crossOrigin || false;
        this.renderer = renderer; // Store the renderer if provided
        
        this.manager = new THREE.LoadingManager(function() {
            // Called when all images are loaded
        }, function() {
            // On progress - noop
        }, function() {
            console.warn('Error loading images');
        });
        this.imageLoader = new THREE.ImageLoader(this.manager);
        this.imageLoader.crossOrigin = crossOrigin;
    },
    
    loadTexture: function(url, mapping, onLoad, onError) {
        var texture = new THREE.Texture(null, mapping);
        
        // Only set anisotropy if renderer is available
        if (this.renderer && this.renderer.capabilities) {
            texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        } else {
            // Use a reasonable default value
            texture.anisotropy = 1;
        }
        
        texture.colorSpace = THREE.SRGBColorSpace;
        
        this.imageLoader.load(url, function(image) {
                texture.image = image;
                texture.needsUpdate = true;
                if (onLoad) onLoad(texture);
            },
            null,
            function(evt) {
                if (onError) onError(evt);
            });
        texture.sourceFile = url;
        return texture;
    }
};
// --------------------
// File: Cell.js
// --------------------
/*
    Simple structure for holding grid coordinates and extra data.
    @author Corey Birnbaum https://github.com/vonWolfehaus/
*/
vg.Cell = function(q, r, s, h) {
    this.q = q || 0;
    this.r = r || 0;
    this.s = s || 0;
    this.h = h || 1;
    this.tile = null;
    this.userData = {};
    this.walkable = true;
    this._calcCost = 0;
    this._priority = 0;
    this._visited = false;
    this._parent = null;
    this.uniqueID = vg.LinkedList.generateID();
};

vg.Cell.prototype = {
    set: function(q, r, s) {
        this.q = q;
        this.r = r;
        this.s = s;
        return this;
    },
    copy: function(cell) {
        this.q = cell.q;
        this.r = cell.r;
        this.s = cell.s;
        this.h = cell.h;
        this.tile = cell.tile || null;
        this.userData = cell.userData || {};
        this.walkable = cell.walkable;
        return this;
    },
    add: function(cell) {
        this.q += cell.q;
        this.r += cell.r;
        this.s += cell.s;
        return this;
    },
    equals: function(cell) {
        return this.q === cell.q && this.r === cell.r && this.s === cell.s;
    }
};

vg.Cell.prototype.constructor = vg.Cell;

// --------------------
// File: HexGrid.js
// --------------------
/*
    Graph of hexagons. Handles grid cell management and conversion math.
    Uses cube/axial coordinates for flat-top hexagons.
    @author Corey Birnbaum https://github.com/vonWolfehaus/
*/
vg.HexGrid = function(config) {
    config = config || {};
    this.type = vg.HEX;
    this.size = 5;
    this.cellSize = typeof config.cellSize === 'undefined' ? 10 : config.cellSize;
    this.cells = {};
    this.numCells = 0;
    this.extrudeSettings = null;
    this.autogenerated = false;
    var i, verts = [];
    for (i = 0; i < 6; i++) {
        verts.push(this._createVertex(i));
    }
    this.cellShape = new THREE.Shape();
    this.cellShape.moveTo(verts[0].x, verts[0].y);
    for (i = 1; i < 6; i++) {
        this.cellShape.lineTo(verts[i].x, verts[i].y);
    }
    this.cellShape.lineTo(verts[0].x, verts[0].y);
    this.cellShape.autoClose = true;
    
    // Update to use BufferGeometry instead of Geometry
    this.cellGeo = new THREE.BufferGeometry();
    const points = [];
    for (i = 0; i < verts.length; i++) {
        points.push(new THREE.Vector3(verts[i].x, verts[i].y, 0));
    }
    this.cellGeo.setFromPoints(points);
    
    // Update to use ShapeGeometry instead of deprecated classes
    this.cellShapeGeo = new THREE.ShapeGeometry(this.cellShape);
    
    this._cellLength = this.cellSize * 2;
    this._cellWidth = vg.SQRT3 * this.cellSize;
    this._hashDelimeter = '.';
    this._directions = [new vg.Cell(1, 0, -1), new vg.Cell(1, -1, 0), new vg.Cell(0, -1, 1),
                        new vg.Cell(-1, 0, 1), new vg.Cell(-1, 1, 0), new vg.Cell(0, 1, -1)];
    this._diagonals = [new vg.Cell(2, -1, -1), new vg.Cell(1, -2, 1), new vg.Cell(-1, -1, 2),
                       new vg.Cell(-2, 1, 1), new vg.Cell(-1, 2, -1), new vg.Cell(1, 1, -2)];
    this._list = [];
    this._vec3 = new THREE.Vector3();
    this._cel = new vg.Cell();
    this._conversionVec = new THREE.Vector3();
    this._geoCache = [];
    this._matCache = [];
};

vg.HexGrid.TWO_THIRDS = 2 / 3;

vg.HexGrid.prototype = {
    cellToPixel: function(cell) {
        this._vec3.x = this.cellSize * (vg.SQRT3 * cell.q + vg.SQRT3/2 * cell.r);
        this._vec3.y = cell.h;
        this._vec3.z = this.cellSize * (1.5 * cell.r);
        return this._vec3;
    },
    pixelToCell: function(pos) {
        var q = (vg.SQRT3/3 * pos.x - 1/3 * pos.z) / this.cellSize;
        var r = (2/3 * pos.z) / this.cellSize;
        this._cel.set(q, r, -q-r);
        return this._cubeRound(this._cel);
    },
    getCellAt: function(pos) {
        var q = (vg.SQRT3/3 * pos.x - 1/3 * pos.z) / this.cellSize;
        var r = (2/3 * pos.z) / this.cellSize;
        this._cel.set(q, r, -q-r);
        this._cubeRound(this._cel);
        return this.cells[this.cellToHash(this._cel)];
    },
    getNeighbors: function(cell, diagonal, filter) {
        var i, n, l = this._directions.length;
        this._list.length = 0;
        for (i = 0; i < l; i++) {
            this._cel.copy(cell);
            this._cel.add(this._directions[i]);
            n = this.cells[this.cellToHash(this._cel)];
            if (!n || (filter && !filter(cell, n))) {
                continue;
            }
            this._list.push(n);
        }
        if (diagonal) {
            for (i = 0; i < l; i++) {
                this._cel.copy(cell);
                this._cel.add(this._diagonals[i]);
                n = this.cells[this.cellToHash(this._cel)];
                if (!n || (filter && !filter(cell, n))) {
                    continue;
                }
                this._list.push(n);
            }
        }
        return this._list;
    },
    getRandomCell: function() {
        var c, i = 0, x = vg.Tools.randomInt(0, this.numCells);
        for (c in this.cells) {
            if (i === x) {
                return this.cells[c];
            }
            i++;
        }
        return this.cells[c];
    },
    cellToHash: function(cell) {
        return cell.q + this._hashDelimeter + cell.r + this._hashDelimeter + cell.s;
    },
    distance: function(cellA, cellB) {
        var d = Math.max(Math.abs(cellA.q - cellB.q), Math.abs(cellA.r - cellB.r), Math.abs(cellA.s - cellB.s));
        d += cellB.h - cellA.h;
        return d;
    },
    clearPath: function() {
        var i, c;
        for (i in this.cells) {
            c = this.cells[i];
            c._calcCost = 0;
            c._priority = 0;
            c._parent = null;
            c._visited = false;
        }
    },
    traverse: function(cb) {
        var i;
        for (i in this.cells) {
            cb(this.cells[i]);
        }
    },
    generateTile: function(cell, scale, material) {
        var height = Math.abs(cell.h);
        if (height < 1) height = 1;
        var geo = this._geoCache[height];
        if (!geo) {
            this.extrudeSettings.depth = height;
			this.extrudeSettings.bevelEnabled= true;
			this.extrudeSettings.bevelSize= 0.1 ;
            geo = new THREE.ExtrudeGeometry(this.cellShape, this.extrudeSettings);
            this._geoCache[height] = geo;
        }
        var tile = new vg.Tile({
            size: this.cellSize,
            scale: scale,
            cell: cell,
            geometry: geo,
            material: material
        });
        cell.tile = tile;
        return tile;
    },
    generateTiles: function(config) {
        config = config || {};
        var tiles = [];
        var settings = {
            tileScale: 0.95,
            cellSize: this.cellSize,
            material: null,
            extrudeSettings: {
                depth: 1,
                bevelEnabled: true,
                bevelSegments: 1,
                steps: 1,
                bevelSize: this.cellSize/20,
                bevelThickness: this.cellSize/20
            }
        };
        settings = vg.Tools.merge(settings, config);
        this.cellSize = settings.cellSize;
        this._cellWidth = this.cellSize * 2;
        this._cellLength = (vg.SQRT3 * 0.5) * this._cellWidth;
        this.autogenerated = true;
        this.extrudeSettings = settings.extrudeSettings;
        var i, t, c;
        for (i in this.cells) {
            c = this.cells[i];
            t = this.generateTile(c, settings.tileScale, settings.material);
            t.position.copy(this.cellToPixel(c));
            t.position.y = 0;
            tiles.push(t);
        }
        return tiles;
    },
    generateTilePoly: function(material) {
        if (!material) {
            material = new THREE.MeshBasicMaterial({color: 0x24b4ff});
        }
        var mesh = new THREE.Mesh(this.cellShapeGeo, material);
        this._vec3.set(1, 0, 0);
        mesh.rotateOnAxis(this._vec3, vg.PI/2);
        return mesh;
    },
    generate: function(config) {
        config = config || {};
        this.size = typeof config.size === 'undefined' ? this.size : config.size;
        var x, y, z, c;
        for (x = -this.size; x < this.size+1; x++) {
            for (y = -this.size; y < this.size+1; y++) {
                z = -x-y;
                if (Math.abs(x) <= this.size && Math.abs(y) <= this.size && Math.abs(z) <= this.size) {
                    c = new vg.Cell(x, y, z);
                    this.add(c);
                }
            }
        }
    },
    generateOverlay: function(size, overlayObj, overlayMat) {
        var x, y, z;
        var geo = new THREE.BufferGeometry().setFromPoints(this.cellShape.getPoints());
        for (x = -size; x < size+1; x++) {
            for (y = -size; y < size+1; y++) {
                z = -x-y;
                if (Math.abs(x) <= size && Math.abs(y) <= size && Math.abs(z) <= size) {
                    this._cel.set(x, y, z);
                    var line = new THREE.Line(geo, overlayMat);
                    line.position.copy(this.cellToPixel(this._cel));
                    line.rotation.x = 90 * vg.DEG_TO_RAD;
                    overlayObj.add(line);
                }
            }
        }
    },
    add: function(cell) {
        var h = this.cellToHash(cell);
        if (this.cells[h]) {
            return;
        }
        this.cells[h] = cell;
        this.numCells++;
        return cell;
    },
    remove: function(cell) {
        var h = this.cellToHash(cell);
        if (this.cells[h]) {
            delete this.cells[h];
            this.numCells--;
        }
    },
    dispose: function() {
        this.cells = null;
        this.numCells = 0;
        this.cellShape = null;
        this.cellGeo.dispose();
        this.cellGeo = null;
        this.cellShapeGeo.dispose();
        this.cellShapeGeo = null;
        this._list = null;
        this._vec3 = null;
        this._conversionVec = null;
        this._geoCache = null;
        this._matCache = null;
    },
    _cubeRound: function(h) {
        var rx = Math.round(h.q);
        var ry = Math.round(h.r);
        var rz = Math.round(h.s);
        var xDiff = Math.abs(rx - h.q);
        var yDiff = Math.abs(ry - h.r);
        var zDiff = Math.abs(rz - h.s);
        if (xDiff > yDiff && xDiff > zDiff) {
            rx = -ry - rz;
        } else if (yDiff > zDiff) {
            ry = -rx - rz;
        } else {
            rz = -rx - ry;
        }
        return this._cel.set(rx, ry, rz);
    },
    _createVertex: function(i) {
        // Calculate angle (60° intervals, starting from top)
        var angle = (2 * Math.PI / 6) * i;
        // Calculate vertex position (pointy-top orientation)
        return new THREE.Vector2(
            this.cellSize * Math.cos(angle), 
            this.cellSize * Math.sin(angle)
        );
    }
};

vg.HexGrid.prototype.constructor = vg.HexGrid;

// --------------------
// File: Tile.js
// --------------------
/*
    Example tile class that constructs its geometry for rendering and holds gameplay properties.
    @author Corey Birnbaum https://github.com/vonWolfehaus/
*/
vg.Tile = function(config) {
    config = config || {};
    var settings = {
        cell: null,
        geometry: null,
        material: null,
        scale: 1
    };
    settings = vg.Tools.merge(settings, config);
    if (!settings.cell || !settings.geometry) {
        throw new Error('Missing vg.Tile configuration');
    }
    this.cell = settings.cell;
    if (this.cell.tile && this.cell.tile !== this) this.cell.tile.dispose();
    this.cell.tile = this;
    this.uniqueID = vg.Tools.generateID();
    this.geometry = settings.geometry;
    this.material = settings.material;
    if (!this.material) {
        this.material = new THREE.MeshStandardMaterial({
            color: vg.Tools.randomizeRGB('30, 30, 30', 13),
			metalness: 0.6,
  			roughness: 0.3,
			emissive: 0xaaaaaa,
        });
    }
    this.objectType = vg.TILE;
    this.entity = null;
    this.userData = {};
    this.selected = false;
    this.highlight = 0x0084cc;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.structure = this;
    this.position = this.mesh.position;
    this.rotation = this.mesh.rotation;
    this.rotation.x = -90 * vg.DEG_TO_RAD;
    this.mesh.scale.set(settings.scale, settings.scale, 1);
    if (this.material.emissive) {
        this._emissive = this.material.emissive.getHex();
    } else {
        this._emissive = null;
    }
};

vg.Tile.prototype = {
    select: function() {
        if (this.material.emissive) {
            this.material.emissive.setHex(this.highlight);
        }
        this.selected = true;
        return this;
    },
    deselect: function() {
        if (this._emissive !== null && this.material.emissive) {
            this.material.emissive.setHex(this._emissive);
        }
        this.selected = false;
        return this;
    },
    toggle: function() {
        if (this.selected) {
            this.deselect();
        } else {
            this.select();
        }
        return this;
    },
    dispose: function() {
        if (this.cell && this.cell.tile) this.cell.tile = null;
        this.cell = null;
        this.position = null;
        this.rotation = null;
        if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
        this.mesh.userData.structure = null;
        this.mesh = null;
        this.material = null;
        this.userData = null;
        this.entity = null;
        this.geometry = null;
        this._emissive = null;
    }
};

vg.Tile.prototype.constructor = vg.Tile;

vg.Tile.prototype.pulseLight = function(scene, options) {
    options = options || {};
    var lightColorStr = options.color || "0xffffff";
    var lightColor;
    if (typeof lightColorStr === "string") {
        if (lightColorStr.indexOf("0x") === 0) {
            lightColor = parseInt(lightColorStr);
        } else if (lightColorStr.indexOf("#") === 0) {
            lightColor = parseInt(lightColorStr.slice(1), 16);
        } else {
            lightColor = parseInt(lightColorStr, 16);
        }
    } else {
        lightColor = lightColorStr;
    }
    var maxIntensity = options.intensity || 1.5;
    var lightDistance = options.distance || 10;
    var duration = options.duration || 500;
    var pointLight = new THREE.PointLight(lightColor, 0, lightDistance);
    pointLight.castShadow = true;
    pointLight.position.set(this.position.x, this.position.y + 5, this.position.z);
    scene.add(pointLight);
    new TWEEN.Tween(pointLight)
        .to({ intensity: maxIntensity }, duration)
        .easing(TWEEN.Easing.Quadratic.Out)
        .yoyo(true)
        .repeat(1)
        .onComplete(function() {
            scene.remove(pointLight);
            if (pointLight.dispose) {
                pointLight.dispose();
            }
        })
        .start();
    if (this.material.emissive) {
        var initialEmissive = {
            r: this.material.emissive.r,
            g: this.material.emissive.g,
            b: this.material.emissive.b
        };
        var targetColor = new THREE.Color(lightColor);
        new TWEEN.Tween(this.material.emissive)
            .to({ r: targetColor.r, g: targetColor.g, b: targetColor.b }, duration)
            .easing(TWEEN.Easing.Quadratic.Out)
            .yoyo(true)
            .repeat(1)
            .onComplete(() => {
                this.material.emissive.setRGB(initialEmissive.r, initialEmissive.g, initialEmissive.b);
            })
            .start();
    }
};

// --------------------
// File: PathAnimator.js
// --------------------
/**
 * Creates an animator for visualizing paths through hex grids.
 * @param {Object} config - Configuration options
 */
vg.PathAnimator = function(config) {
  config = config || {};
  this.duration = config.duration || 500;
  this.easing = config.easing || TWEEN.Easing.Quadratic.Out;
  this.pathColor = config.color || 0x00ffff;
  this.pathHeight = config.height || 1.0;
  this.pathThickness = config.thickness || 0.2;
  this.highlightDuration = config.highlightDuration || 300;
  this.maxIntensity = config.maxIntensity || 1.5;
  this.signal = new vg.Signal();
  this.tweenGroup = new TWEEN.Group();
};

vg.PathAnimator.prototype = {
  animatePath: function(path, options) {
    options = options || {};
    var self = this;
    var color = options.color || this.pathColor;
    var height = options.height || this.pathHeight;
    var scene = options.scene;
    var hexGrid = options.hexGrid;
    if (!scene || !hexGrid) {
      console.error('[vg.PathAnimator] scene and hexGrid are required');
      return null;
    }
    var pathList = path;
    if (!(path instanceof vg.LinkedList)) {
      pathList = new vg.LinkedList();
      for (var i = 0; i < path.length; i++) {
        if (!path[i].uniqueID) {
          path[i].uniqueID = vg.LinkedList.generateID();
        }
        pathList.add(path[i]);
      }
    }
    if (pathList.length === 0) {
      this.signal.dispatch('complete', null);
      return null;
    }
    var isAnimating = true;
    var currentNode = pathList.first;
    var pathMeshes = [];
    this.signal.dispatch('start', { path: pathList });
    var marker = null;
    if (options.useMarker) {
      marker = this._createMarker(color);
      scene.add(marker);
      if (currentNode && currentNode.obj) {
        var startPos = this._getCellPosition(currentNode.obj, hexGrid, height);
        marker.position.copy(startPos);
      }
    }
    var animateNextStep = function() {
      if (!isAnimating || !currentNode || !currentNode.obj) {
        self._finishAnimation(pathMeshes, marker, scene, pathList);
        return;
      }
      self._highlightCellWithWaveEffect(currentNode.obj, color, height, hexGrid);
      self.signal.dispatch('cell', {
        cell: currentNode.obj,
        index: pathMeshes.length
      });
      if (currentNode.next && currentNode.next.obj) {
        var fromCell = currentNode.obj;
        var toCell = currentNode.next.obj;
        var pathSegment = self._createPathSegment(fromCell, toCell, color, height, hexGrid, options.pathThickness || self.pathThickness);
        if (pathSegment) {
          scene.add(pathSegment);
          pathMeshes.push(pathSegment);
          if (marker) {
            var endPos = self._getCellPosition(toCell, hexGrid, height);
            new TWEEN.Tween(marker.position, self.tweenGroup)
              .to({ x: endPos.x, y: endPos.y, z: endPos.z }, self.duration)
              .easing(self.easing)
              .start();
          }
          self._animatePathSegmentColor(pathSegment, color);
          currentNode = currentNode.next;
          setTimeout(animateNextStep, self.duration);
        } else {
          currentNode = currentNode.next;
          animateNextStep();
        }
      } else {
        self._finishAnimation(pathMeshes, marker, scene, pathList);
      }
    };
    setTimeout(animateNextStep, 0);
    return {
      isAnimating: function() { return isAnimating; },
      cancel: function() {
        isAnimating = false;
        pathMeshes.forEach(function(mesh) {
          scene.remove(mesh);
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) mesh.material.dispose();
        });
        if (marker) {
          scene.remove(marker);
          if (marker.geometry) marker.geometry.dispose();
          if (marker.material) marker.material.dispose();
        }
        self.signal.dispatch('cancelled', { pathMeshes: pathMeshes });
      },
      getMeshes: function() { return pathMeshes; }
    };
  },
  _createMarker: function(color) {
    return new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 8, 8),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xaaaaaa,
        metalness: 0.8,
        roughness: 0.2,
      })
    );
  },
  _createPathSegment: function(fromCell, toCell, color, height, hexGrid, thickness) {
    if (!fromCell || !toCell || !hexGrid) return null;
    var fromPos = this._getCellPosition(fromCell, hexGrid, 0);
    var toPos = this._getCellPosition(toCell, hexGrid, 0);
    var direction = new THREE.Vector3(toPos.x - fromPos.x, 0, toPos.z - fromPos.z);
    var length = direction.length();
    if (length === 0) return null;
    direction.normalize();
    var material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.9,
      roughness: 0.5,
      emissive: 0xffffff,
    });
    var geometry = new THREE.CylinderGeometry(thickness, thickness, length, 8, 1, false);
    var cylinder = new THREE.Mesh(geometry, material);
    cylinder.position.set((fromPos.x + toPos.x) / 2, height + 0.1, (fromPos.z + toPos.z) / 2);
    cylinder.rotateX(Math.PI / 2);
    var xzAngle = Math.atan2(direction.z, direction.x);
    cylinder.rotateY(xzAngle);
    cylinder.castShadow = true;
    cylinder.receiveShadow = true;
    return cylinder;
  },
  _animatePathSegmentColor: function(pathSegment, targetColor) {
    if (!pathSegment || !(pathSegment.material instanceof THREE.MeshStandardMaterial)) return;
    var material = pathSegment.material;
    var targetColorObj = new THREE.Color(targetColor);
    var colorValues = { r: 1, g: 1, b: 1, er: 0.7, eg: 0.7, eb: 0.7 };
    var targetValues = { r: targetColorObj.r, g: targetColorObj.g, b: targetColorObj.b, er: targetColorObj.r * 0.3, eg: targetColorObj.g * 0.3, eb: targetColorObj.b * 0.3 };
    new TWEEN.Tween(colorValues, this.tweenGroup)
      .to(targetValues, 1000)
      .easing(TWEEN.Easing.Quadratic.Out)
      .onUpdate(function() {
        material.color.setRGB(colorValues.r, colorValues.g, colorValues.b);
        material.emissive.setRGB(colorValues.er, colorValues.eg, colorValues.eb);
        material.needsUpdate = true;
      })
      .start();
  },
  _highlightCellWithWaveEffect: function(cell, color, height, hexGrid) {
    if (!cell) return;
    var targetColorObj = new THREE.Color(color);
    if (cell.tile && typeof cell.tile.pulseLight === 'function') {
      cell.tile.pulseLight(this._getSceneFromTile(cell.tile), {
        color: 0xffffff,
        duration: this.highlightDuration,
        maxIntensity: this.maxIntensity,
        fadeToColor: targetColorObj.getHex()
      });
      if (cell.tile.mesh && cell.tile.mesh.material) {
        this._animateTileMaterial(cell.tile.mesh.material, targetColorObj);
      }
    } else if (hexGrid) {
      var cellHash = null;
      if (cell.q !== undefined && cell.r !== undefined) {
        var s = -cell.q - cell.r;
        cellHash = hexGrid.cellToHash({q: cell.q, r: cell.r, s: s});
      }
      if (cellHash && hexGrid.cells[cellHash] && hexGrid.cells[cellHash].tile && typeof hexGrid.cells[cellHash].tile.pulseLight === 'function') {
        hexGrid.cells[cellHash].tile.pulseLight(
          this._getSceneFromTile(hexGrid.cells[cellHash].tile),
          {
            color: 0xffffff,
            duration: this.highlightDuration,
            maxIntensity: this.maxIntensity,
            fadeToColor: targetColorObj.getHex()
          }
        );
      }
    }
  },
  _animateTileMaterial: function(material, targetColor) {
    if (!material || !(material instanceof THREE.MeshStandardMaterial)) return;
    //var originalColor = material.color.clone();
    //var originalEmissive = material.emissive.clone();
    material.color.set(0xffffff);
    material.emissive.set(0xaaaaaa);
    var colorValues = { r: 1, g: 1, b: 1, er: 0.7, eg: 0.7, eb: 0.7 };
    var targetValues = { r: targetColor.r, g: targetColor.g, b: targetColor.b, er: targetColor.r * 0.3, eg: targetColor.g * 0.3, eb: targetColor.b * 0.3 };
    new TWEEN.Tween(colorValues, this.tweenGroup)
      .to(targetValues, 800)
      .easing(TWEEN.Easing.Quadratic.Out)
      .onUpdate(function() {
        material.color.setRGB(colorValues.r, colorValues.g, colorValues.b);
        material.emissive.setRGB(colorValues.er, colorValues.eg, colorValues.eb);
        material.needsUpdate = true;
      })
      .start();
  },
  _getCellPosition: function(cell, hexGrid, height) {
    var pos;
    if (cell.tile && cell.tile.position) {
      pos = cell.tile.position.clone();
    } else if (cell.q !== undefined && cell.r !== undefined) {
      pos = hexGrid.cellToPixel(cell);
    } else if (cell.position) {
      pos = cell.position.clone();
    } else {
      pos = new THREE.Vector3(0, 0, 0);
      console.warn('[vg.PathAnimator] Unable to determine cell position');
    }
    pos.y = height || 0;
    return pos;
  },
  _getSceneFromTile: function(tile) {
    if (!tile || !tile.mesh) return null;
    var parent = tile.mesh.parent;
    while (parent && !(parent instanceof THREE.Scene)) {
      parent = parent.parent;
    }
    return parent;
  },
  _finishAnimation: function(pathMeshes, marker, scene, pathList) {
    if (marker) {
      scene.remove(marker);
      if (marker.geometry) marker.geometry.dispose();
      if (marker.material) marker.material.dispose();
    }
    this.signal.dispatch('complete', {
      pathMeshes: pathMeshes,
      path: pathList
    });
  },
  Update: function(time) {
    this.tweeGroup.update(time);
  },
  Dispose: function() {
    if (this.signal) {
      this.signal.dispose();
    }
    this.tweenGroup = null;
  }
};

vg.PathAnimator.prototype.constructor = vg.PathAnimator;

// --------------------
// File: Scene.js
// --------------------
/*
    Sets up and manages a THREE.js container, camera, and light.
    Assumes full screen.
*/
vg.Scene = function(sceneConfig, controlConfig) {
    var sceneSettings = {
        element: document.body,
        alpha: true,
        antialias: true,
        clearColor: '#fff',
        sortObjects: false,
        fog: null,
        light: new THREE.DirectionalLight(0xffffff),
        lightPosition: null,
        cameraType: 'PerspectiveCamera',
        cameraPosition: null,
        orthoZoom: 4,
        width: 800,
        height: 600,
        enableShadows: true,
        preferWebGPU: true,
        useOrbitControls: false
    };

    var controlSettings = {
        minDistance: 100,
        maxDistance: 1000,
        zoomSpeed: 2,
        noZoom: false
    };

    sceneSettings = vg.Tools.merge(sceneSettings, sceneConfig);
    if (typeof controlConfig !== 'boolean') {
        controlSettings = vg.Tools.merge(controlSettings, controlConfig);
    }

    this.usingWebGPU = false;
    try {
        console.log('Checking WebGPU availability...');
        console.log('navigator.gpu available:', typeof navigator !== 'undefined' && !!navigator.gpu);
        console.log('WebGPURenderer available:', typeof window.WebGPURenderer !== 'undefined');
        console.log('THREE.WebGPURenderer available:', typeof THREE.WebGPURenderer !== 'undefined');
        
        if (sceneSettings.preferWebGPU && 
            typeof navigator !== 'undefined' && !!navigator.gpu) {
            // Check if WebGPURenderer is available
            if (typeof window.WebGPURenderer !== 'undefined') {
                try {
                    console.log('Attempting to initialize WebGPU renderer...');
                    this.renderer = new window.WebGPURenderer({
                        alpha: sceneSettings.alpha,
                        antialias: sceneSettings.antialias
                    });
                    
                    // Check if the renderer is functional
                    if (this.renderer && typeof this.renderer.render === 'function') {
                        this.usingWebGPU = true;
                        console.log('Successfully initialized WebGPU renderer');
                    } else {
                        console.warn('WebGPURenderer is not functional, falling back to WebGL');
                        throw new Error('WebGPURenderer is not functional');
                    }
                } catch (rendererError) {
                    console.warn('Error initializing WebGPURenderer:', rendererError);
                    throw rendererError;
                }
            } else {
                console.warn('WebGPURenderer is not defined, falling back to WebGL');
                throw new Error('WebGPURenderer is not defined');
            }
        } else {
            console.log('WebGPU not preferred or navigator.gpu not available');
            throw new Error('WebGPU not available or not preferred');
        }
    } catch (e) {
        console.log('Falling back to WebGL renderer:', e);
        this.renderer = new THREE.WebGLRenderer({
            alpha: sceneSettings.alpha,
            antialias: sceneSettings.antialias
        });
        this.usingWebGPU = false;
    }
    
    this.renderer.setClearColor(sceneSettings.clearColor, 0);
    this.renderer.sortObjects = sceneSettings.sortObjects;

    if (sceneSettings.enableShadows) {
        this.renderer.shadowMap.enabled = true;
        if (this.renderer.shadowMap.type !== undefined) {
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        }
    }

    this.width = sceneSettings.width || 800;
    this.height = sceneSettings.height || 600;
    
    if (sceneSettings.cameraType === 'OrthographicCamera') {
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
    } else {
        this.camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
    }

    this.container = new THREE.Scene();
    this.container.fog = sceneSettings.fog;
    this.container.add(new THREE.AmbientLight(0xdddddd));

    if (!sceneSettings.lightPosition) {
        sceneSettings.light.position.set(-1, 1, -1).normalize();
    }
    this.container.add(sceneSettings.light);

    if (sceneSettings.cameraPosition) {
        this.camera.position.copy(sceneSettings.cameraPosition);
    }

    this.attachTo(sceneSettings.element);
    
    // Add OrbitControls if requested
    if (sceneSettings.useOrbitControls && typeof THREE.OrbitControls !== 'undefined') {
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.25;
        this.controls.screenSpacePanning = true;
        
        if (controlSettings) {
            if (controlSettings.minDistance) this.controls.minDistance = controlSettings.minDistance;
            if (controlSettings.maxDistance) this.controls.maxDistance = controlSettings.maxDistance;
            if (controlSettings.zoomSpeed) this.controls.zoomSpeed = controlSettings.zoomSpeed;
            if (controlSettings.noZoom) this.controls.enableZoom = !controlSettings.noZoom;
        }
    }
};

vg.Scene.prototype = {
    attachTo: function(element) {
        if (!element) {
            console.warn('Scene.attachTo called with no element, using document.body');
            element = document.body;
        }
        if (element && element !== document.body) {
            var rect = element.getBoundingClientRect();
            if (rect.width > 0) {
                this.width = rect.width;
            } else {
                console.warn('Element has no width, using default width:', this.width);
            }
            if (rect.height > 0) {
                this.height = rect.height;
            } else {
                console.warn('Element has no height, using default height:', this.height);
            }
        }
        this.width = this.width || 800;
        this.height = this.height || 600;
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(this.width, this.height);
        if (this.camera.type === 'OrthographicCamera') {
            var width = this.width / this.orthoZoom;
            var height = this.height / this.orthoZoom;
            this.camera.left = width / -2;
            this.camera.right = width / 2;
            this.camera.top = height / 2;
            this.camera.bottom = height / -2;
        } else {
            this.camera.aspect = this.width / this.height;
        }
        this.camera.updateProjectionMatrix();
        element.appendChild(this.renderer.domElement);
    },
    add: function(mesh) {
        this.container.add(mesh);
    },
    remove: function(mesh) {
        this.container.remove(mesh);
    },
    render: function() {
        if (this.controls && this.controls.update) {
            this.controls.update();
        }
        this.renderer.render(this.container, this.camera);
    },
    updateOrthoZoom: function() {
        if (this.orthoZoom <= 0) {
            this.orthoZoom = 0;
            return;
        }
        var width = this.width / this.orthoZoom;
        var height = this.height / this.orthoZoom;
        this.camera.left = width / -2;
        this.camera.right = width / 2;
        this.camera.top = height / 2;
        this.camera.bottom = height / -2;
        this.camera.updateProjectionMatrix();
    },
    focusOn: function(obj) {
        this.camera.lookAt(obj.position);
    },
    updateSize: function(width, height) {
        this.width = width;
        this.height = height;
        if (this.camera.type === 'OrthographicCamera') {
            var viewWidth = this.width / this.orthoZoom;
            var viewHeight = this.height / this.orthoZoom;
            this.camera.left = viewWidth / -2;
            this.camera.right = viewWidth / 2;
            this.camera.top = viewHeight / 2;
            this.camera.bottom = viewHeight / -2;
        } else {
            this.camera.aspect = this.width / this.height;
        }
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.width, this.height);
    }
};

vg.Scene.prototype.constructor = vg.Scene;

// --------------------
// File: Board.js
// --------------------
/*
    Manages a grid and its tiles.
    @author Corey Birnbaum https://github.com/vonWolfehaus/
*/
vg.Board = function(grid, finderConfig) {
    this.tiles = [];
    this.tileGroup = new THREE.Group();
    this.group = new THREE.Group();
    this.group.add(this.tileGroup);
    this.grid = null;
    this.overlay = null;
    this.finder = null;
    
    if (grid) {
        this.setGrid(grid);
    }
};

vg.Board.prototype = {
    setEntityOnTile: function(entity, tile) {
        tile.entity = entity;
        entity.tile = tile;
        entity.position.copy(tile.position);
        entity.position.y += entity.height * 0.5;
        return this;
    },
    addTile: function(tile) {
        this.tiles.push(tile);
        this.tileGroup.add(tile.mesh);
        return this;
    },
    removeTile: function(tile) {
        if (!tile) return;
        var i = this.tiles.indexOf(tile);
        if (i !== -1) {
            this.tiles.splice(i, 1);
        }
        this.tileGroup.remove(tile.mesh);
        return this;
    },
    removeAllTiles: function() {
        var i = this.tiles.length;
        while (i--) {
            this.tileGroup.remove(this.tiles[i].mesh);
        }
        this.tiles = [];
        return this;
    },
    getTileAtCell: function(cell) {
        var i = this.tiles.length;
        while (i--) {
            if (this.tiles[i].cell.equals(cell)) {
                return this.tiles[i];
            }
        }
        return null;
    },
    snapToGrid: function(pos) {
        var cell = this.grid.pixelToCell(pos);
        cell.h = 0;
        pos.copy(this.grid.cellToPixel(cell));
        return this;
    },
    snapTileToGrid: function(tile) {
        if (!this.grid) return;
        tile.position.copy(this.grid.cellToPixel(tile.cell));
        return this;
    },
    getRandomTile: function() {
        var i = vg.Tools.randomInt(0, this.tiles.length - 1);
        return this.tiles[i];
    },
    findPath: function(startTile, endTile, heuristic) {
        var startCell = startTile.cell;
        var endCell = endTile.cell;
        var path = this.finder.findPath(startCell, endCell, heuristic);
        return path;
    },
    setGrid: function(grid) {
        this.grid = grid;
        return this;
    },
    generateOverlay: function(size) {
        size = size || 0.2;
        var material = new THREE.LineBasicMaterial({
            color: 0x888888,
            opacity: 0.5
        });
        this.overlay = new THREE.Group();
        this.grid.generateOverlay(this.grid.size, this.overlay, material);
        this.group.add(this.overlay);
        return this;
    },
    generateTilemap: function(config) {
        var tiles = this.grid.generateTiles(config);
        for (var i = 0; i < tiles.length; i++) {
            this.addTile(tiles[i]);
        }
        return this;
    },
    reset: function() {
        this.removeAllTiles();
        if (this.overlay) {
            this.group.remove(this.overlay);
            this.overlay = null;
        }
        return this;
    }
};

vg.Board.prototype.constructor = vg.Board;