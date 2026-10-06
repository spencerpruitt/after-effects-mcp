// __mcpBridgeIIFE: all panel code runs in one function scope, so user scripts can't clobber panel
// state. Globals: __mcpBridgeCheck (polled by app.scheduleTask), __mcpBridgeTaskId and __mcpCompileUserCode.
// The JSON and Date polyfills install globally.

// Unlike standard JS, ExtendScript's new Function can read AND assign the locals of the scope it is
// called from, so user code must be compiled here at top level, never inside the IIFE below.
function __mcpCompileUserCode(__mcpCode) {
    return new Function("sandbox", "system", __mcpCode);
}

// thisObj is the dockable Panel AE passes when this file is opened from the Window menu.
(function (thisObj) {









function createComposition(args) {
    try {
        var name = args.name || "New Composition";
        var width = parseInt(args.width) || 1920;
        var height = parseInt(args.height) || 1080;
        var pixelAspect = parseFloat(args.pixelAspect) || 1.0;
        var duration = parseFloat(args.duration) || 10.0;
        var frameRate = parseFloat(args.frameRate) || 30.0;
        var bgColor = args.backgroundColor ? [args.backgroundColor.r/255, args.backgroundColor.g/255, args.backgroundColor.b/255] : [0, 0, 0];
        var newComp = app.project.items.addComp(name, width, height, pixelAspect, duration, frameRate);
        if (args.backgroundColor) {
            newComp.bgColor = bgColor;
        }
        return JSON.stringify({
            status: "success", message: "Composition created successfully",
            composition: { name: newComp.name, id: newComp.id, width: newComp.width, height: newComp.height, pixelAspect: newComp.pixelAspect, duration: newComp.duration, frameRate: newComp.frameRate, bgColor: newComp.bgColor }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}


function createTextLayer(args) {
    try {
        var compName = args.compName || "";
        var text = args.text || "Text Layer";
        var position = args.position || [960, 540]; 
        var fontSize = args.fontSize || 72;
        var color = args.color || [1, 1, 1]; 
        var startTime = args.startTime || 0;
        var duration = args.duration || 5; 
        var fontFamily = args.fontFamily || "Arial";
        var alignment = args.alignment || "center"; 
        var comp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === compName) { comp = item; break; }
        }
        if (!comp) {
            if (app.project.activeItem instanceof CompItem) { comp = app.project.activeItem; } 
            else { throw new Error("No composition found with name '" + compName + "' and no active composition"); }
        }
        var textLayer = comp.layers.addText(text);
        var textProp = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var textDocument = textProp.value;
        textDocument.fontSize = fontSize;
        textDocument.fillColor = color;
        textDocument.font = fontFamily;
        if (alignment === "left") { textDocument.justification = ParagraphJustification.LEFT_JUSTIFY; } 
        else if (alignment === "center") { textDocument.justification = ParagraphJustification.CENTER_JUSTIFY; } 
        else if (alignment === "right") { textDocument.justification = ParagraphJustification.RIGHT_JUSTIFY; }
        textProp.setValue(textDocument);
        textLayer.property("Position").setValue(position);
        if (args.name) { textLayer.name = args.name; }
        textLayer.startTime = startTime;
        if (duration > 0) { textLayer.outPoint = startTime + duration; }
        return JSON.stringify({
            status: "success", message: "Text layer created successfully",
            layer: { name: textLayer.name, index: textLayer.index, type: "text", inPoint: textLayer.inPoint, outPoint: textLayer.outPoint, position: textLayer.property("Position").value }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}


function createShapeLayer(args) {
    try {
        var compName = args.compName || "";
        var shapeType = args.shapeType || "rectangle"; 
        var position = args.position || [960, 540]; 
        var size = args.size || [200, 200]; 
        var fillColor = args.fillColor || [1, 0, 0]; 
        var strokeColor = args.strokeColor || [0, 0, 0]; 
        var strokeWidth = args.strokeWidth || 0; 
        var startTime = args.startTime || 0;
        var duration = args.duration || 5; 
        var name = args.name || "Shape Layer";
        var points = args.points || 5; 
        var comp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === compName) { comp = item; break; }
        }
        if (!comp) {
            if (app.project.activeItem instanceof CompItem) { comp = app.project.activeItem; } 
            else { throw new Error("No composition found with name '" + compName + "' and no active composition"); }
        }
        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = name;
        var contents = shapeLayer.property("Contents"); 
        var shapeGroup = contents.addProperty("ADBE Vector Group");
        var groupContents = shapeGroup.property("Contents"); 
        var shapePathProperty;
        if (shapeType === "rectangle") {
            shapePathProperty = groupContents.addProperty("ADBE Vector Shape - Rect");
            shapePathProperty.property("Size").setValue(size);
            if (args.roundness) { shapePathProperty.property("Roundness").setValue(args.roundness); }
        } else if (shapeType === "ellipse") {
            shapePathProperty = groupContents.addProperty("ADBE Vector Shape - Ellipse");
            shapePathProperty.property("Size").setValue(size);
        } else if (shapeType === "polygon" || shapeType === "star") { 
            shapePathProperty = groupContents.addProperty("ADBE Vector Shape - Star");
            shapePathProperty.property("Type").setValue(shapeType === "polygon" ? 1 : 2); 
            shapePathProperty.property("Points").setValue(points);
            shapePathProperty.property("Outer Radius").setValue(size[0] / 2);
            if (shapeType === "star") { shapePathProperty.property("Inner Radius").setValue(size[0] / 3); }
        }
        var fill = groupContents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue(fillColor);
        fill.property("Opacity").setValue(100);
        if (strokeWidth > 0) {
            var stroke = groupContents.addProperty("ADBE Vector Graphic - Stroke");
            stroke.property("Color").setValue(strokeColor);
            stroke.property("Stroke Width").setValue(strokeWidth);
            stroke.property("Opacity").setValue(100);
        }
        shapeLayer.property("Position").setValue(position);
        shapeLayer.startTime = startTime;
        if (duration > 0) { shapeLayer.outPoint = startTime + duration; }
        return JSON.stringify({
            status: "success", message: "Shape layer created successfully",
            layer: { name: shapeLayer.name, index: shapeLayer.index, type: "shape", shapeType: shapeType, inPoint: shapeLayer.inPoint, outPoint: shapeLayer.outPoint, position: shapeLayer.property("Position").value }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}


function createSolidLayer(args) {
    try {
        var compName = args.compName || "";
        var color = args.color || [1, 1, 1]; 
        var name = args.name || "Solid Layer";
        var position = args.position || [960, 540]; 
        var size = args.size; 
        var startTime = args.startTime || 0;
        var duration = args.duration || 5; 
        var isAdjustment = args.isAdjustment || false; 
        var comp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === compName) { comp = item; break; }
        }
        if (!comp) {
            if (app.project.activeItem instanceof CompItem) { comp = app.project.activeItem; } 
            else { throw new Error("No composition found with name '" + compName + "' and no active composition"); }
        }
        if (!size) { size = [comp.width, comp.height]; }
        var solidLayer;
        if (isAdjustment) {
            solidLayer = comp.layers.addSolid([0, 0, 0], name, size[0], size[1], 1);
            solidLayer.adjustmentLayer = true;
        } else {
            solidLayer = comp.layers.addSolid(color, name, size[0], size[1], 1);
        }
        solidLayer.property("Position").setValue(position);
        solidLayer.startTime = startTime;
        if (duration > 0) { solidLayer.outPoint = startTime + duration; }
        return JSON.stringify({
            status: "success", message: isAdjustment ? "Adjustment layer created successfully" : "Solid layer created successfully",
            layer: { name: solidLayer.name, index: solidLayer.index, type: isAdjustment ? "adjustment" : "solid", inPoint: solidLayer.inPoint, outPoint: solidLayer.outPoint, position: solidLayer.property("Position").value, isAdjustment: solidLayer.adjustmentLayer }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}


function setLayerProperties(args) {
    try {
        var compName = args.compName || "";
        var layerName = args.layerName || "";
        var layerIndex = args.layerIndex; 
        
        
        var position = args.position; 
        var scale = args.scale; 
        var rotation = args.rotation; 
        var opacity = args.opacity; 
        var startTime = args.startTime; 
        var duration = args.duration; 

        
        var textContent = args.text; 
        var fontFamily = args.fontFamily; 
        var fontSize = args.fontSize; 
        var fillColor = args.fillColor; 
        
        
        var comp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === compName) { comp = item; break; }
        }
        if (!comp) {
            if (app.project.activeItem instanceof CompItem) { comp = app.project.activeItem; } 
            else { throw new Error("No composition found with name '" + compName + "' and no active composition"); }
        }
        
        
        var layer = null;
        if (layerIndex !== undefined && layerIndex !== null) {
            if (layerIndex > 0 && layerIndex <= comp.numLayers) { layer = comp.layer(layerIndex); } 
            else { throw new Error("Layer index out of bounds: " + layerIndex); }
        } else if (layerName) {
            for (var j = 1; j <= comp.numLayers; j++) {
                if (comp.layer(j).name === layerName) { layer = comp.layer(j); break; }
            }
        }
        if (!layer) { throw new Error("Layer not found: " + (layerName || "index " + layerIndex)); }
        
        var changedProperties = [];
        var textDocumentChanged = false;
        var textProp = null;
        var textDocument = null;

        
        if (layer instanceof TextLayer && (textContent !== undefined || fontFamily !== undefined || fontSize !== undefined || fillColor !== undefined)) {
            var sourceTextProp = layer.property("Source Text");
            if (sourceTextProp && sourceTextProp.value) {
                var currentTextDocument = sourceTextProp.value; 
                var updated = false;

                if (textContent !== undefined && textContent !== null && currentTextDocument.text !== textContent) {
                    currentTextDocument.text = textContent;
                    changedProperties.push("text");
                    updated = true;
                }
                if (fontFamily !== undefined && fontFamily !== null && currentTextDocument.font !== fontFamily) {
                    
                    
                    currentTextDocument.font = fontFamily;
                    changedProperties.push("fontFamily");
                    updated = true;
                }
                if (fontSize !== undefined && fontSize !== null && currentTextDocument.fontSize !== fontSize) {
                    currentTextDocument.fontSize = fontSize;
                    changedProperties.push("fontSize");
                    updated = true;
                }
                
                
                if (fillColor !== undefined && fillColor !== null && 
                    (currentTextDocument.fillColor[0] !== fillColor[0] || 
                     currentTextDocument.fillColor[1] !== fillColor[1] || 
                     currentTextDocument.fillColor[2] !== fillColor[2])) {
                    currentTextDocument.fillColor = fillColor;
                    changedProperties.push("fillColor");
                    updated = true;
                }

                
                if (updated) {
                    try {
                        sourceTextProp.setValue(currentTextDocument);
                        logToPanel("Applied changes to Text Document for layer: " + layer.name);
                    } catch (e) {
                        logToPanel("ERROR applying Text Document changes: " + e.toString());
                        
                        
                    }
                }
                 
                 textDocument = currentTextDocument; 

            } else {
                logToPanel("Warning: Could not access Source Text property for layer: " + layer.name);
            }
        }

        
        if (position !== undefined && position !== null) { layer.property("Position").setValue(position); changedProperties.push("position"); }
        if (scale !== undefined && scale !== null) { layer.property("Scale").setValue(scale); changedProperties.push("scale"); }
        if (rotation !== undefined && rotation !== null) {
            if (layer.threeDLayer) { 
                
                layer.property("Z Rotation").setValue(rotation);
            } else { 
                layer.property("Rotation").setValue(rotation); 
            }
            changedProperties.push("rotation");
        }
        if (opacity !== undefined && opacity !== null) { layer.property("Opacity").setValue(opacity); changedProperties.push("opacity"); }
        if (args.newName) { layer.name = args.newName; changedProperties.push("name"); }
        if (args.parentName !== undefined) { layer.parent = args.parentName ? comp.layer(args.parentName) : null; changedProperties.push("parent"); }
        if (startTime !== undefined && startTime !== null) { layer.startTime = startTime; changedProperties.push("startTime"); }
        if (duration !== undefined && duration !== null && duration > 0) {
            var actualStartTime = (startTime !== undefined && startTime !== null) ? startTime : layer.startTime;
            layer.outPoint = actualStartTime + duration;
            changedProperties.push("duration");
        }

        
        var returnLayerInfo = {
            name: layer.name,
            index: layer.index,
            position: layer.property("Position").value,
            scale: layer.property("Scale").value,
            rotation: layer.threeDLayer ? layer.property("Z Rotation").value : layer.property("Rotation").value, 
            opacity: layer.property("Opacity").value,
            inPoint: layer.inPoint,
            outPoint: layer.outPoint,
            changedProperties: changedProperties
        };
        
        if (layer instanceof TextLayer && textDocument) {
            returnLayerInfo.text = textDocument.text;
            returnLayerInfo.fontFamily = textDocument.font;
            returnLayerInfo.fontSize = textDocument.fontSize;
            returnLayerInfo.fillColor = textDocument.fillColor;
        }

        
        logToPanel("Final check before return:");
        logToPanel("  Changed Properties: " + changedProperties.join(", "));
        logToPanel("  Return Layer Info Font: " + (returnLayerInfo.fontFamily || "N/A")); 
        logToPanel("  TextDocument Font: " + (textDocument ? textDocument.font : "N/A"));

        return JSON.stringify({
            status: "success", message: "Layer properties updated successfully",
            layer: returnLayerInfo
        }, null, 2);
    } catch (error) {
        
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

function coerceScriptValue(rawValue) {
    if (rawValue === undefined || rawValue === null) {
        return rawValue;
    }

    if (typeof rawValue !== "string") {
        return rawValue;
    }

    var trimmed = rawValue.replace(/^\s+|\s+$/g, "");
    if (trimmed === "") {
        return rawValue;
    }

    
    var firstChar = trimmed.charAt(0);
    if (firstChar === "[" || firstChar === "{" || firstChar === '"' || trimmed === "true" || trimmed === "false" || trimmed === "null") {
        try {
            return JSON.parse(trimmed);
        } catch (e) {
            
        }
    }

    
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return parseFloat(trimmed);
    }

    return rawValue;
}


function setLayerKeyframe(compIndex, layerIndex, propertyName, timeInSeconds, value) {
    try {
        
        var comp = app.project.items[compIndex];
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, message: "Composition not found at index " + compIndex });
        }
        var layer = comp.layers[layerIndex];
        if (!layer) {
            return JSON.stringify({ success: false, message: "Layer not found at index " + layerIndex + " in composition '" + comp.name + "'"});
        }

        var transformGroup = layer.property("Transform");
        if (!transformGroup) {
             return JSON.stringify({ success: false, message: "Transform properties not found for layer '" + layer.name + "' (type: " + layer.matchName + ")." });
        }

        var property = transformGroup.property(propertyName);
        if (!property) {
            
             if (layer.property("Effects") && layer.property("Effects").property(propertyName)) {
                 property = layer.property("Effects").property(propertyName);
             } else if (layer.property("Text") && layer.property("Text").property(propertyName)) {
                 property = layer.property("Text").property(propertyName);
            } 

            if (!property) {
                 return JSON.stringify({ success: false, message: "Property '" + propertyName + "' not found on layer '" + layer.name + "'." });
            }
        }


        
        if (!property.canVaryOverTime) {
             return JSON.stringify({ success: false, message: "Property '" + propertyName + "' cannot be keyframed." });
        }

        
        if (property.numKeys === 0 && !property.isTimeVarying) {
             property.setValueAtTime(comp.time, property.value); 
        }


        var normalizedValue = coerceScriptValue(value);
        property.setValueAtTime(timeInSeconds, normalizedValue);

        return JSON.stringify({ success: true, message: "Keyframe set for '" + propertyName + "' on layer '" + layer.name + "' at " + timeInSeconds + "s.", value: normalizedValue });
    } catch (e) {
        return JSON.stringify({ success: false, message: "Error setting keyframe: " + e.toString() + " (Line: " + e.line + ")" });
    }
}



function setLayerExpression(compIndex, layerIndex, propertyName, expressionString) {
    try {
         
        var comp = app.project.items[compIndex];
         if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, message: "Composition not found at index " + compIndex });
        }
        var layer = comp.layers[layerIndex];
         if (!layer) {
            return JSON.stringify({ success: false, message: "Layer not found at index " + layerIndex + " in composition '" + comp.name + "'"});
        }

        var transformGroup = layer.property("Transform");
         if (!transformGroup) {
             
             
        }

        var property = transformGroup ? transformGroup.property(propertyName) : null;
         if (!property) {
            
             if (layer.property("Effects") && layer.property("Effects").property(propertyName)) {
                 property = layer.property("Effects").property(propertyName);
             } else if (layer.property("Text") && layer.property("Text").property(propertyName)) {
                 property = layer.property("Text").property(propertyName);
             } 

            if (!property) {
                 return JSON.stringify({ success: false, message: "Property '" + propertyName + "' not found on layer '" + layer.name + "'." });
            }
        }

        if (!property.canSetExpression) {
            return JSON.stringify({ success: false, message: "Property '" + propertyName + "' does not support expressions." });
        }

        property.expression = expressionString;

        var action = expressionString === "" ? "removed" : "set";
        return JSON.stringify({ success: true, message: "Expression " + action + " for '" + propertyName + "' on layer '" + layer.name + "'." });
    } catch (e) {
        return JSON.stringify({ success: false, message: "Error setting expression: " + e.toString() + " (Line: " + e.line + ")" });
    }
}

function tryAddEffect(layer, identifier, mode) {
    if (!identifier) {
        return null;
    }

    try {
        if (mode === "matchName") {
            return layer.Effects.addProperty(identifier);
        }
        if (mode === "name") {
            return layer.Effects.addProperty(identifier);
        }
    } catch (e) {
        return null;
    }

    return null;
}

function addEffectByAnyIdentifier(layer, effectIdentifier, effectName, effectMatchName) {
    var attempts = [];
    var effect = null;

    if (effectMatchName) {
        attempts.push({ value: effectMatchName, mode: "matchName" });
    }

    if (effectIdentifier) {
        attempts.push({ value: effectIdentifier, mode: "matchName" });
        attempts.push({ value: effectIdentifier, mode: "name" });
    }

    if (effectName) {
        attempts.push({ value: effectName, mode: "name" });
    }

    for (var i = 0; i < attempts.length; i++) {
        effect = tryAddEffect(layer, attempts[i].value, attempts[i].mode);
        if (effect) {
            return {
                effect: effect,
                resolvedBy: attempts[i]
            };
        }
    }

    return null;
}


function applyEffect(args) {
    try {
        
        var compIndex = args.compIndex || 1; 
        var layerIndex = args.layerIndex || 1; 
        var resolvedTarget = resolveCompAndLayer(args); compIndex = resolvedTarget.compIndex; layerIndex = resolvedTarget.layerIndex;
        var effectIdentifier = args.effect || args.effectIdentifier; 
        var effectName = args.effectName; 
        var effectMatchName = args.effectMatchName; 
        var effectCategory = args.effectCategory || ""; 
        var presetPath = args.presetPath; 
        var effectSettings = args.effectSettings || {}; 
        
        if (!effectIdentifier && !effectName && !effectMatchName && !presetPath) {
            throw new Error("You must specify effect, effectIdentifier, effectName, effectMatchName, or presetPath");
        }
        
        
        var comp = app.project.item(compIndex);
        if (!comp || !(comp instanceof CompItem)) {
            throw new Error("Composition not found at index " + compIndex);
        }
        
        
        var layer = comp.layer(layerIndex);
        if (!layer) {
            throw new Error("Layer not found at index " + layerIndex + " in composition '" + comp.name + "'");
        }
        
        var effectResult;
        
        
        if (presetPath) {
            var presetFile = new File(presetPath);
            if (!presetFile.exists) {
                throw new Error("Effect preset file not found: " + presetPath);
            }
            
            
            layer.applyPreset(presetFile);
            effectResult = {
                type: "preset",
                name: presetPath.split('/').pop().split('\\').pop(),
                applied: true
            };
        }
        
        else if (effectMatchName || effectName || effectIdentifier) {
            var added = addEffectByAnyIdentifier(layer, effectIdentifier, effectName, effectMatchName);
            if (!added || !added.effect) {
                throw new Error("Could not add effect. Try a valid effectMatchName (for example: 'ADBE Gaussian Blur 2') or exact effect display name.");
            }

            var effect = added.effect;
            effectResult = {
                type: "effect",
                name: effect.name,
                matchName: effect.matchName,
                index: effect.propertyIndex,
                resolvedBy: added.resolvedBy
            };
            
            
            applyEffectSettings(effect, effectSettings);
        }
        
        return JSON.stringify({
            status: "success",
            message: "Effect applied successfully",
            effect: effectResult,
            layer: {
                name: layer.name,
                index: layerIndex
            },
            composition: {
                name: comp.name,
                index: compIndex
            }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}


function applyEffectSettings(effect, settings) {
    
    var hasAnySetting = false;
    if (!settings) {
        return;
    }
    for (var key in settings) {
        if (settings.hasOwnProperty(key)) {
            hasAnySetting = true;
            break;
        }
    }
    if (!hasAnySetting) {
        return;
    }
    
    
    for (var propName in settings) {
        if (settings.hasOwnProperty(propName)) {
            try {
                
                var property = null;
                
                
                try {
                    property = effect.property(propName);
                } catch (e) {
                    
                    for (var i = 1; i <= effect.numProperties; i++) {
                        var prop = effect.property(i);
                        if (prop.name === propName) {
                            property = prop;
                            break;
                        }
                    }
                }
                
                
                if (property && property.setValue) {
                    property.setValue(coerceScriptValue(settings[propName]));
                }
            } catch (e) {
                
                $.writeln("Error setting effect property '" + propName + "': " + e.toString());
            }
        }
    }
}

function findPropertyByNameOrMatchName(container, propertyName) {
    if (!container || !propertyName || !container.numProperties) {
        return null;
    }

    for (var i = 1; i <= container.numProperties; i++) {
        var candidate = container.property(i);
        if (candidate && (candidate.name === propertyName || candidate.matchName === propertyName)) {
            return candidate;
        }
    }

    return null;
}

function resolvePropertyPath(rootProperty, pathTokens) {
    var current = rootProperty;

    for (var i = 0; i < pathTokens.length; i++) {
        if (!current) {
            return null;
        }

        var token = pathTokens[i];
        var nextProperty = null;

        if (typeof token === "number") {
            nextProperty = current.property(token);
        } else {
            nextProperty = current.property(token);
            if (!nextProperty) {
                nextProperty = findPropertyByNameOrMatchName(current, token);
            }
        }

        current = nextProperty;
    }

    return current;
}

function normalizePropertyPath(pathInput) {
    if (pathInput instanceof Array) {
        return pathInput;
    }

    if (typeof pathInput === "string" && pathInput.length > 0) {
        return pathInput.split("/");
    }

    return [];
}

function readPropertyValue(prop) {
    try {
        if (!prop || prop.propertyType === PropertyType.NAMED_GROUP || prop.propertyType === PropertyType.INDEXED_GROUP) {
            return null;
        }
        return prop.value;
    } catch (e) {
        return null;
    }
}

function serializeEffectProperty(prop, includeValues, currentDepth, maxDepth) {
    var propertyInfo = {
        name: prop.name,
        matchName: prop.matchName,
        index: prop.propertyIndex,
        canSetExpression: !!prop.canSetExpression,
        canVaryOverTime: !!prop.canVaryOverTime,
        numKeys: prop.numKeys || 0,
        isGroup: prop.propertyType === PropertyType.NAMED_GROUP || prop.propertyType === PropertyType.INDEXED_GROUP,
        children: []
    };

    if (includeValues) {
        propertyInfo.value = readPropertyValue(prop);
    }

    if (propertyInfo.isGroup && currentDepth < maxDepth && prop.numProperties) {
        for (var i = 1; i <= prop.numProperties; i++) {
            var child = prop.property(i);
            if (child) {
                propertyInfo.children.push(serializeEffectProperty(child, includeValues, currentDepth + 1, maxDepth));
            }
        }
    }

    return propertyInfo;
}

function resolveCompAndLayer(args) {
    var compIndex = args.compIndex || 1;
    var layerIndex = args.layerIndex || 1;
    // Optional name-based targeting (compName / layerName) instead of indices
    if (args.compName) {
        for (var ci = 1; ci <= app.project.numItems; ci++) {
            var it = app.project.item(ci);
            if (it instanceof CompItem && it.name === args.compName) { compIndex = ci; break; }
        }
    }
    if (args.layerName) {
        var byName = app.project.item(compIndex).layer(args.layerName);
        if (byName) { layerIndex = byName.index; }
    }

    var comp = app.project.item(compIndex);
    if (!comp || !(comp instanceof CompItem)) {
        throw new Error("Composition not found at index " + compIndex);
    }

    var layer = comp.layer(layerIndex);
    if (!layer) {
        throw new Error("Layer not found at index " + layerIndex + " in composition '" + comp.name + "'");
    }

    return {
        comp: comp,
        layer: layer,
        compIndex: compIndex,
        layerIndex: layerIndex
    };
}

function resolveEffectOnLayer(layer, args) {
    var effectsGroup = layer.property("Effects");
    if (!effectsGroup) {
        throw new Error("Layer has no Effects group");
    }

    var effect = null;

    if (args.effectIndex !== undefined && args.effectIndex !== null) {
        effect = effectsGroup.property(args.effectIndex);
    }

    if (!effect && args.effectName) {
        effect = findPropertyByNameOrMatchName(effectsGroup, args.effectName);
    }

    if (!effect && args.effectMatchName) {
        effect = findPropertyByNameOrMatchName(effectsGroup, args.effectMatchName);
    }

    if (!effect) {
        throw new Error("Effect not found on layer. Provide effectIndex, effectName, or effectMatchName.");
    }

    return effect;
}

function listLayerEffects(args) {
    try {
        var resolved = resolveCompAndLayer(args || {});
        var layer = resolved.layer;
        var effectsGroup = layer.property("Effects");
        var includeProperties = !!args.includeProperties;
        var includeValues = !!args.includeValues;
        var maxDepth = args.maxDepth || 2;

        var effects = [];
        if (effectsGroup && effectsGroup.numProperties) {
            for (var i = 1; i <= effectsGroup.numProperties; i++) {
                var effect = effectsGroup.property(i);
                var effectInfo = {
                    index: effect.propertyIndex,
                    name: effect.name,
                    matchName: effect.matchName,
                    enabled: effect.enabled
                };

                if (includeProperties) {
                    effectInfo.properties = [];
                    for (var j = 1; j <= effect.numProperties; j++) {
                        var child = effect.property(j);
                        effectInfo.properties.push(serializeEffectProperty(child, includeValues, 1, maxDepth));
                    }
                }

                effects.push(effectInfo);
            }
        }

        return JSON.stringify({
            status: "success",
            composition: {
                name: resolved.comp.name,
                index: resolved.compIndex
            },
            layer: {
                name: layer.name,
                index: resolved.layerIndex
            },
            effectCount: effects.length,
            effects: effects
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}

function listAvailableEffects(args) {
    try {
        var params = args || {};
        var query = params.query ? String(params.query).toLowerCase() : "";
        var includeObsolete = !!params.includeObsolete;
        var maxResults = (params.maxResults !== undefined && params.maxResults !== null)
            ? Number(params.maxResults)
            : 5000;

        if (!app.effects) {
            throw new Error("After Effects app.effects API is not available in this version.");
        }

        var effectsCollection = app.effects;
        var collectionCount = 0;
        if (effectsCollection.length !== undefined && effectsCollection.length !== null) {
            collectionCount = Number(effectsCollection.length);
        } else if (effectsCollection.numEffects !== undefined && effectsCollection.numEffects !== null) {
            collectionCount = Number(effectsCollection.numEffects);
        }

        var effects = [];
        for (var i = 0; i < collectionCount; i++) {
            var effectObj = null;
            try {
                effectObj = effectsCollection[i];
            } catch (e1) {
                effectObj = null;
            }
            if (!effectObj && effectsCollection.effect) {
                try {
                    effectObj = effectsCollection.effect(i + 1);
                } catch (e2) {
                    effectObj = null;
                }
            }
            if (!effectObj) {
                continue;
            }

            var name = "";
            var matchName = "";
            var category = "";
            var isObsolete = false;

            try { name = effectObj.displayName || effectObj.name || ""; } catch (e3) {}
            try { matchName = effectObj.matchName || ""; } catch (e4) {}
            try { category = effectObj.category || ""; } catch (e5) {}
            try { isObsolete = !!effectObj.isObsolete; } catch (e6) {}

            if (!includeObsolete && isObsolete) {
                continue;
            }

            if (query) {
                var haystack = (String(name) + " " + String(matchName) + " " + String(category)).toLowerCase();
                if (haystack.indexOf(query) === -1) {
                    continue;
                }
            }

            effects.push({
                index: i,
                name: name,
                matchName: matchName,
                category: category,
                isObsolete: isObsolete
            });

            if (effects.length >= maxResults) {
                break;
            }
        }

        return JSON.stringify({
            status: "success",
            query: query || null,
            includeObsolete: includeObsolete,
            returnedCount: effects.length,
            totalScanned: collectionCount,
            effects: effects
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}

function getInterpolationTypeByName(name) {
    if (!name) {
        return null;
    }

    var normalized = String(name).toLowerCase();
    if (normalized === "linear") {
        return KeyframeInterpolationType.LINEAR;
    }
    if (normalized === "bezier") {
        return KeyframeInterpolationType.BEZIER;
    }
    if (normalized === "hold") {
        return KeyframeInterpolationType.HOLD;
    }

    return null;
}

function getPropertyDimensionCount(property) {
    try {
        var value = property.value;
        if (value instanceof Array) {
            return value.length;
        }
    } catch (e) {
        
    }
    return 1;
}

function findKeyIndexAtTime(property, timeInSeconds) {
    var epsilon = 0.0001;
    for (var i = 1; i <= property.numKeys; i++) {
        if (Math.abs(property.keyTime(i) - timeInSeconds) <= epsilon) {
            return i;
        }
    }
    return -1;
}

function buildEaseArray(dimensionCount, speed, influence) {
    var easeArray = [];
    var resolvedSpeed = (speed !== undefined && speed !== null) ? Number(speed) : 0;
    var resolvedInfluence = (influence !== undefined && influence !== null) ? Number(influence) : 33.333;

    for (var i = 0; i < dimensionCount; i++) {
        easeArray.push(new KeyframeEase(resolvedSpeed, resolvedInfluence));
    }

    return easeArray;
}

function buildEaseArrayFromSpec(dimensionCount, spec, fallbackSpeed, fallbackInfluence) {
    if (spec instanceof Array) {
        var result = [];
        for (var i = 0; i < dimensionCount; i++) {
            var item = spec[i] || spec[spec.length - 1] || {};
            var itemSpeed = (item.speed !== undefined && item.speed !== null) ? Number(item.speed) : fallbackSpeed;
            var itemInfluence = (item.influence !== undefined && item.influence !== null) ? Number(item.influence) : fallbackInfluence;
            result.push(new KeyframeEase(itemSpeed, itemInfluence));
        }
        return result;
    }

    var speed = spec && spec.speed;
    var influence = spec && spec.influence;
    return buildEaseArray(
        dimensionCount,
        (speed !== undefined && speed !== null) ? speed : fallbackSpeed,
        (influence !== undefined && influence !== null) ? influence : fallbackInfluence
    );
}

function getKeyframeOptionsFromArgs(args) {
    var options = args.keyframeOptions || {};

    
    if (args.easyEase !== undefined) {
        options.easyEase = args.easyEase;
    }
    if (args.interpolationIn !== undefined) {
        options.interpolationIn = args.interpolationIn;
    }
    if (args.interpolationOut !== undefined) {
        options.interpolationOut = args.interpolationOut;
    }
    if (args.temporalContinuous !== undefined) {
        options.temporalContinuous = args.temporalContinuous;
    }
    if (args.temporalAutoBezier !== undefined) {
        options.temporalAutoBezier = args.temporalAutoBezier;
    }
    if (args.roving !== undefined) {
        options.roving = args.roving;
    }
    if (args.easeIn !== undefined) {
        options.easeIn = args.easeIn;
    }
    if (args.easeOut !== undefined) {
        options.easeOut = args.easeOut;
    }
    if (args.spatialTangentsIn !== undefined) {
        options.spatialTangentsIn = args.spatialTangentsIn;
    }
    if (args.spatialTangentsOut !== undefined) {
        options.spatialTangentsOut = args.spatialTangentsOut;
    }
    if (args.spatialContinuous !== undefined) {
        options.spatialContinuous = args.spatialContinuous;
    }
    if (args.spatialAutoBezier !== undefined) {
        options.spatialAutoBezier = args.spatialAutoBezier;
    }

    return options;
}

function applyKeyframeGraphOptions(property, keyIndex, options) {
    if (!options) {
        return;
    }

    var dimensionCount = getPropertyDimensionCount(property);

    if (options.easyEase) {
        var easyInfluence = (options.easyEaseInfluence !== undefined && options.easyEaseInfluence !== null)
            ? Number(options.easyEaseInfluence)
            : 33.333;
        var easyIn = buildEaseArray(dimensionCount, 0, easyInfluence);
        var easyOut = buildEaseArray(dimensionCount, 0, easyInfluence);
        property.setTemporalEaseAtKey(keyIndex, easyIn, easyOut);
    }

    if (options.easeIn || options.easeOut) {
        var inEase = buildEaseArrayFromSpec(dimensionCount, options.easeIn, 0, 33.333);
        var outEase = buildEaseArrayFromSpec(dimensionCount, options.easeOut, 0, 33.333);
        property.setTemporalEaseAtKey(keyIndex, inEase, outEase);
    }

    var inInterpolation = getInterpolationTypeByName(options.interpolationIn);
    var outInterpolation = getInterpolationTypeByName(options.interpolationOut);
    if (inInterpolation || outInterpolation) {
        if (!inInterpolation) {
            inInterpolation = property.keyInInterpolationType(keyIndex);
        }
        if (!outInterpolation) {
            outInterpolation = property.keyOutInterpolationType(keyIndex);
        }
        property.setInterpolationTypeAtKey(keyIndex, inInterpolation, outInterpolation);
    }

    if (options.temporalContinuous !== undefined) {
        property.setTemporalContinuousAtKey(keyIndex, !!options.temporalContinuous);
    }

    if (options.temporalAutoBezier !== undefined) {
        property.setTemporalAutoBezierAtKey(keyIndex, !!options.temporalAutoBezier);
    }

    if (options.roving !== undefined) {
        try {
            property.setRovingAtKey(keyIndex, !!options.roving);
        } catch (e) {
            
        }
    }

    if (options.spatialTangentsIn !== undefined || options.spatialTangentsOut !== undefined) {
        try {
            var inTangent = options.spatialTangentsIn;
            var outTangent = options.spatialTangentsOut;
            if (inTangent === undefined || inTangent === null) {
                inTangent = property.keyInSpatialTangent(keyIndex);
            }
            if (outTangent === undefined || outTangent === null) {
                outTangent = property.keyOutSpatialTangent(keyIndex);
            }
            property.setSpatialTangentsAtKey(keyIndex, inTangent, outTangent);
        } catch (e) {
            
        }
    }

    if (options.spatialContinuous !== undefined) {
        try {
            property.setSpatialContinuousAtKey(keyIndex, !!options.spatialContinuous);
        } catch (e) {
            
        }
    }

    if (options.spatialAutoBezier !== undefined) {
        try {
            property.setSpatialAutoBezierAtKey(keyIndex, !!options.spatialAutoBezier);
        } catch (e) {
            
        }
    }
}

function setEffectProperty(args) {
    try {
        var resolved = resolveCompAndLayer(args || {});
        var effect = resolveEffectOnLayer(resolved.layer, args || {});
        var propertyPath = normalizePropertyPath(args.propertyPath);
        var targetProperty = null;

        if (propertyPath.length > 0) {
            targetProperty = resolvePropertyPath(effect, propertyPath);
        }

        if (!targetProperty && args.propertyName) {
            targetProperty = findPropertyByNameOrMatchName(effect, args.propertyName);
        }

        if (!targetProperty && args.propertyIndex !== undefined && args.propertyIndex !== null) {
            targetProperty = effect.property(args.propertyIndex);
        }

        if (!targetProperty) {
            throw new Error("Target effect property not found. Provide propertyPath, propertyName, or propertyIndex.");
        }

        var previousValue = readPropertyValue(targetProperty);

        if (args.expressionString !== undefined && args.expressionString !== null) {
            if (!targetProperty.canSetExpression) {
                throw new Error("Property '" + targetProperty.name + "' does not support expressions.");
            }
            targetProperty.expression = args.expressionString;
        }

        var keyframeIndex = (args.keyframeIndex !== undefined && args.keyframeIndex !== null)
            ? Number(args.keyframeIndex)
            : -1;
        var keyframeApplied = false;

        if (args.value !== undefined) {
            if (args.timeInSeconds !== undefined && args.timeInSeconds !== null) {
                if (!targetProperty.canVaryOverTime) {
                    throw new Error("Property '" + targetProperty.name + "' cannot be keyframed.");
                }
                targetProperty.setValueAtTime(args.timeInSeconds, coerceScriptValue(args.value));
            } else if (keyframeIndex > 0 && targetProperty.setValueAtKey) {
                targetProperty.setValueAtKey(keyframeIndex, coerceScriptValue(args.value));
            } else if (targetProperty.setValue) {
                targetProperty.setValue(coerceScriptValue(args.value));
            } else {
                throw new Error("Property '" + targetProperty.name + "' is not directly writable.");
            }
        }

        if (args.timeInSeconds !== undefined && args.timeInSeconds !== null) {
            keyframeIndex = findKeyIndexAtTime(targetProperty, args.timeInSeconds);
            if (keyframeIndex < 0) {
                throw new Error("Could not find keyframe at the requested time after update.");
            }
        }

        var graphOptions = getKeyframeOptionsFromArgs(args);
        var hasGraphOptions = false;
        for (var graphKey in graphOptions) {
            if (graphOptions.hasOwnProperty(graphKey)) {
                hasGraphOptions = true;
                break;
            }
        }

        if (keyframeIndex > 0 && (hasGraphOptions || (args.timeInSeconds !== undefined && args.timeInSeconds !== null))) {
            applyKeyframeGraphOptions(targetProperty, keyframeIndex, graphOptions);
            keyframeApplied = true;
        }

        return JSON.stringify({
            status: "success",
            message: "Effect property updated successfully",
            composition: {
                name: resolved.comp.name,
                index: resolved.compIndex
            },
            layer: {
                name: resolved.layer.name,
                index: resolved.layerIndex
            },
            effect: {
                index: effect.propertyIndex,
                name: effect.name,
                matchName: effect.matchName
            },
            property: {
                name: targetProperty.name,
                matchName: targetProperty.matchName,
                index: targetProperty.propertyIndex,
                previousValue: previousValue,
                currentValue: readPropertyValue(targetProperty),
                expressionEnabled: targetProperty.canSetExpression ? (targetProperty.expression !== "") : false,
                keyframeApplied: keyframeApplied,
                keyframeIndex: keyframeIndex
            },
            keyframeTimeInSeconds: (args.timeInSeconds !== undefined && args.timeInSeconds !== null) ? args.timeInSeconds : null
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}

function setEffectKeyframe(args) {
    if ((args.timeInSeconds === undefined || args.timeInSeconds === null) &&
        (args.keyframeIndex === undefined || args.keyframeIndex === null)) {
        return JSON.stringify({
            status: "error",
            message: "timeInSeconds or keyframeIndex is required for setEffectKeyframe"
        }, null, 2);
    }

    if (args.value === undefined) {
        return JSON.stringify({
            status: "error",
            message: "value is required for setEffectKeyframe"
        }, null, 2);
    }

    return setEffectProperty(args);
}

function applyLayerPreset(args) {
    try {
        var resolved = resolveCompAndLayer(args || {});
        var presetPath = args.presetPath;

        if (!presetPath) {
            throw new Error("presetPath is required.");
        }

        var presetFile = new File(presetPath);
        if (!presetFile.exists) {
            throw new Error("Preset file not found: " + presetPath);
        }

        resolved.layer.applyPreset(presetFile);

        return JSON.stringify({
            status: "success",
            message: "Preset applied successfully",
            composition: {
                name: resolved.comp.name,
                index: resolved.compIndex
            },
            layer: {
                name: resolved.layer.name,
                index: resolved.layerIndex
            },
            presetPath: presetFile.fsName
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}

function createAdjustmentLayer(args) {
    try {
        var params = args || {};
        var compName = params.compName || "";
        var name = params.name || "Adjustment Layer";
        var position = params.position;
        var size = params.size;
        var startTime = params.startTime || 0;
        var duration = params.duration || 5;

        var comp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.name === compName) {
                comp = item;
                break;
            }
        }

        if (!comp) {
            if (app.project.activeItem instanceof CompItem) {
                comp = app.project.activeItem;
            } else {
                throw new Error("No composition found with name '" + compName + "' and no active composition");
            }
        }

        if (!size) {
            size = [comp.width, comp.height];
        }

        if (!position) {
            position = [comp.width / 2, comp.height / 2];
        }

        var adjustmentLayer = comp.layers.addSolid([0, 0, 0], name, size[0], size[1], 1);
        adjustmentLayer.adjustmentLayer = true;
        adjustmentLayer.property("Position").setValue(position);
        adjustmentLayer.startTime = startTime;
        if (duration > 0) {
            adjustmentLayer.outPoint = startTime + duration;
        }

        return JSON.stringify({
            status: "success",
            message: "Adjustment layer created successfully",
            layer: {
                name: adjustmentLayer.name,
                index: adjustmentLayer.index,
                type: "adjustment",
                inPoint: adjustmentLayer.inPoint,
                outPoint: adjustmentLayer.outPoint,
                position: adjustmentLayer.property("Position").value,
                isAdjustment: adjustmentLayer.adjustmentLayer
            }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}

function centerLayers(args) {
    try {
        var params = args || {};
        var compIndex = params.compIndex || 1;
        var comp = app.project.item(compIndex);
        if (!comp || !(comp instanceof CompItem)) {
            throw new Error("Composition not found at index " + compIndex);
        }
        var centerX = comp.width / 2;
        var centerY = comp.height / 2;
        var centered = [];

        function centerOneLayer(layer) {
            if (!layer) {
                return;
            }
            var positionProp = layer.property("Transform").property("Position");
            if (!positionProp || !positionProp.setValue) {
                return;
            }

            var current = positionProp.value;
            var nextValue = null;
            if (current instanceof Array && current.length >= 3) {
                nextValue = [centerX, centerY, current[2]];
            } else {
                nextValue = [centerX, centerY];
            }
            positionProp.setValue(nextValue);

            centered.push({
                index: layer.index,
                name: layer.name,
                position: nextValue
            });
        }

        if (params.allLayers) {
            for (var i = 1; i <= comp.numLayers; i++) {
                centerOneLayer(comp.layer(i));
            }
        } else if (params.selectedOnly) {
            var selected = comp.selectedLayers || [];
            for (var j = 0; j < selected.length; j++) {
                centerOneLayer(selected[j]);
            }
        } else if (params.layerName) {
            var target = null;
            for (var k = 1; k <= comp.numLayers; k++) {
                if (comp.layer(k).name === params.layerName) {
                    target = comp.layer(k);
                    break;
                }
            }
            if (!target) {
                throw new Error("Layer not found with name '" + params.layerName + "'.");
            }
            centerOneLayer(target);
        } else {
            centerOneLayer(comp.layer(params.layerIndex || 1));
        }

        return JSON.stringify({
            status: "success",
            message: "Layer centering completed",
            composition: {
                name: comp.name,
                index: compIndex,
                center: [centerX, centerY]
            },
            centeredCount: centered.length,
            centeredLayers: centered
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}

function getLayerClipFrames(args) {
    try {
        var params = args || {};
        var compIndex = params.compIndex || 1;
        var comp = app.project.item(compIndex);
        if (!comp || !(comp instanceof CompItem)) {
            throw new Error("Composition not found at index " + compIndex);
        }

        var layer = null;
        if (params.layerIndex !== undefined && params.layerIndex !== null) {
            if (params.layerIndex > 0 && params.layerIndex <= comp.numLayers) {
                layer = comp.layer(params.layerIndex);
            } else {
                throw new Error("Layer index out of bounds: " + params.layerIndex);
            }
        } else if (params.layerName) {
            for (var i = 1; i <= comp.numLayers; i++) {
                if (comp.layer(i).name === params.layerName) {
                    layer = comp.layer(i);
                    break;
                }
            }
            if (!layer) {
                throw new Error("Layer not found with name '" + params.layerName + "'.");
            }
        } else {
            throw new Error("Provide layerIndex or layerName.");
        }

        var frameDuration = comp.frameDuration;
        function toFrameNumber(timeValue) {
            return Math.round(timeValue / frameDuration);
        }

        var clipStartTime = layer.inPoint;
        var clipEndTime = layer.outPoint;
        var layerStartTime = layer.startTime;
        var sourceStartTime = layer.inPoint - layer.startTime;
        var sourceEndTime = layer.outPoint - layer.startTime;

        return JSON.stringify({
            status: "success",
            composition: {
                name: comp.name,
                index: compIndex,
                frameRate: comp.frameRate,
                frameDuration: frameDuration
            },
            layer: {
                name: layer.name,
                index: layer.index,
                sourceName: layer.source ? layer.source.name : null,
                startTimeSeconds: layerStartTime,
                startFrame: toFrameNumber(layerStartTime),
                clipStartTimeSeconds: clipStartTime,
                clipStartFrame: toFrameNumber(clipStartTime),
                clipEndTimeSeconds: clipEndTime,
                clipEndFrame: toFrameNumber(clipEndTime),
                sourceStartTimeSeconds: sourceStartTime,
                sourceStartFrame: toFrameNumber(sourceStartTime),
                sourceEndTimeSeconds: sourceEndTime,
                sourceEndFrame: toFrameNumber(sourceEndTime),
                durationSeconds: clipEndTime - clipStartTime,
                durationFrames: toFrameNumber(clipEndTime - clipStartTime)
            }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}

function getLayerAudioInfo(args) {
    try {
        var params = args || {};
        var compIndex = params.compIndex || 1;
        var comp = app.project.item(compIndex);
        if (!comp || !(comp instanceof CompItem)) {
            throw new Error("Composition not found at index " + compIndex);
        }

        var layer = null;
        if (params.layerIndex !== undefined && params.layerIndex !== null) {
            layer = comp.layer(params.layerIndex);
            if (!layer) { throw new Error("Layer not found at index " + params.layerIndex); }
        } else if (params.layerName) {
            for (var i = 1; i <= comp.numLayers; i++) {
                if (comp.layer(i).name === params.layerName) { layer = comp.layer(i); break; }
            }
            if (!layer) { throw new Error("Layer not found with name '" + params.layerName + "'."); }
        } else {
            throw new Error("Provide layerIndex or layerName.");
        }

        var hasAudio = layer.hasAudio || false;
        var audioEnabled = layer.audioEnabled || false;
        var sourceInfo = null;
        var sourceFilePath = null;

        if (layer.source) {
            var src = layer.source;
            sourceInfo = {
                name: src.name,
                hasAudio: src.hasAudio || false,
                audioChannels: src.audioChannels || 0,
                audioSampleRate: src.audioSampleRate || 0,
                audioDuration: src.audioDuration || 0
            };
            if (src.file) {
                sourceFilePath = src.file.fsName;
            }
        }

        var audioLevelsValue = null;
        var audioLevelsKeyframes = [];
        try {
            var audioGroup = layer.property("Audio");
            if (audioGroup) {
                var levProp = null;
                try { levProp = audioGroup.property("Audio Levels"); } catch (e) {}
                if (!levProp) {
                    for (var j = 1; j <= audioGroup.numProperties; j++) {
                        var ap = audioGroup.property(j);
                        if (ap.matchName === "ADBE Audio Levels" || ap.name === "Audio Levels") {
                            levProp = ap; break;
                        }
                    }
                }
                if (levProp) {
                    audioLevelsValue = levProp.value;
                    for (var k = 1; k <= levProp.numKeys; k++) {
                        audioLevelsKeyframes.push({
                            index: k,
                            timeInSeconds: levProp.keyTime(k),
                            value: levProp.keyValue(k)
                        });
                    }
                }
            }
        } catch (e) {}

        var existingMarkers = [];
        try {
            var markerProp = layer.property("Marker");
            if (markerProp) {
                for (var m = 1; m <= markerProp.numKeys; m++) {
                    var mv = markerProp.keyValue(m);
                    existingMarkers.push({
                        index: m,
                        timeInSeconds: markerProp.keyTime(m),
                        comment: mv.comment,
                        duration: mv.duration,
                        label: mv.label
                    });
                }
            }
        } catch (e) {}

        return JSON.stringify({
            status: "success",
            composition: { name: comp.name, index: compIndex, frameRate: comp.frameRate },
            layer: {
                name: layer.name,
                index: layer.index,
                hasAudio: hasAudio,
                audioEnabled: audioEnabled,
                inPoint: layer.inPoint,
                outPoint: layer.outPoint
            },
            source: sourceInfo,
            sourceFilePath: sourceFilePath,
            audioLevels: { currentValue: audioLevelsValue, keyframes: audioLevelsKeyframes },
            existingMarkers: existingMarkers
        }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

function addMarkersFromArray(args) {
    try {
        var params = args || {};
        var compIndex = params.compIndex || 1;
        var comp = app.project.item(compIndex);
        if (!comp || !(comp instanceof CompItem)) {
            throw new Error("Composition not found at index " + compIndex);
        }

        var markers = params.markers;
        if (!markers || !(markers instanceof Array) || markers.length === 0) {
            throw new Error("markers must be a non-empty array of {timeInSeconds, comment?, duration?, label?} objects.");
        }

        var markerType = params.markerType || "layer";
        var layer = null;

        if (markerType === "layer") {
            if (params.layerIndex !== undefined && params.layerIndex !== null) {
                layer = comp.layer(params.layerIndex);
                if (!layer) { throw new Error("Layer not found at index " + params.layerIndex); }
            } else if (params.layerName) {
                for (var i = 1; i <= comp.numLayers; i++) {
                    if (comp.layer(i).name === params.layerName) { layer = comp.layer(i); break; }
                }
                if (!layer) { throw new Error("Layer not found with name '" + params.layerName + "'."); }
            } else {
                throw new Error("Provide layerIndex or layerName for layer markers, or set markerType to 'comp'.");
            }
        }

        var added = [];
        var errors = [];

        for (var j = 0; j < markers.length; j++) {
            try {
                var spec = markers[j];
                var timeInSeconds = Number(spec.timeInSeconds);
                var mv = new MarkerValue(spec.comment || "");
                mv.duration = (spec.duration !== undefined && spec.duration !== null) ? Number(spec.duration) : 0;
                if (spec.chapter)  { mv.chapter = spec.chapter; }
                if (spec.url)      { mv.url     = spec.url;     }
                if (spec.label)    { mv.label   = Number(spec.label); }

                if (markerType === "comp") {
                    comp.markerProperty.setValueAtTime(timeInSeconds, mv);
                } else {
                    layer.property("Marker").setValueAtTime(timeInSeconds, mv);
                }
                added.push({ timeInSeconds: timeInSeconds, comment: spec.comment || "" });
            } catch (e) {
                errors.push({ index: j, timeInSeconds: markers[j].timeInSeconds, error: e.toString() });
            }
        }

        return JSON.stringify({
            status: "success",
            message: "Bulk marker insertion complete",
            addedCount: added.length,
            errorCount: errors.length,
            added: added,
            errors: errors,
            composition: { name: comp.name, index: compIndex },
            layer: layer ? { name: layer.name, index: layer.index } : null
        }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

function addMarker(args) {
    try {
        var params = args || {};
        var compIndex = params.compIndex || 1;
        var comp = app.project.item(compIndex);
        if (!comp || !(comp instanceof CompItem)) {
            throw new Error("Composition not found at index " + compIndex);
        }

        var timeInSeconds = (params.timeInSeconds !== undefined && params.timeInSeconds !== null)
            ? Number(params.timeInSeconds)
            : comp.time;

        var comment  = params.comment  || "";
        var chapter  = params.chapter  || "";
        var url      = params.url      || "";
        var duration = (params.duration !== undefined && params.duration !== null) ? Number(params.duration) : 0;
        var label    = (params.label   !== undefined && params.label   !== null) ? Number(params.label)   : 0;

        var markerVal = new MarkerValue(comment);
        markerVal.duration = duration;
        if (chapter)  { markerVal.chapter    = chapter;  }
        if (url)      { markerVal.url        = url;      }
        if (label)    { markerVal.label      = label;    }

        var markerType = params.markerType || "layer"; 

        if (markerType === "comp") {
            comp.markerProperty.setValueAtTime(timeInSeconds, markerVal);
            return JSON.stringify({
                status: "success",
                message: "Composition marker added",
                composition: { name: comp.name, index: compIndex },
                marker: { timeInSeconds: timeInSeconds, comment: comment, duration: duration, label: label }
            }, null, 2);
        }

        
        var layer = null;
        if (params.layerIndex !== undefined && params.layerIndex !== null) {
            layer = comp.layer(params.layerIndex);
            if (!layer) { throw new Error("Layer not found at index " + params.layerIndex); }
        } else if (params.layerName) {
            for (var i = 1; i <= comp.numLayers; i++) {
                if (comp.layer(i).name === params.layerName) { layer = comp.layer(i); break; }
            }
            if (!layer) { throw new Error("Layer not found with name '" + params.layerName + "'."); }
        } else {
            throw new Error("Provide layerIndex or layerName for a layer marker, or set markerType to 'comp'.");
        }

        var markerProp = layer.property("Marker");
        if (!markerProp) { throw new Error("Layer '" + layer.name + "' does not support markers."); }
        markerProp.setValueAtTime(timeInSeconds, markerVal);

        return JSON.stringify({
            status: "success",
            message: "Layer marker added",
            composition: { name: comp.name, index: compIndex },
            layer: { name: layer.name, index: layer.index },
            marker: { timeInSeconds: timeInSeconds, comment: comment, duration: duration, label: label }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

function setLayerAudioLevels(args) {
    try {
        var resolved = resolveCompAndLayer(args || {});
        var layer = resolved.layer;

        var audioGroup = layer.property("Audio");
        if (!audioGroup) {
            throw new Error("Layer '" + layer.name + "' has no Audio property. Ensure it is an audio or AV layer.");
        }

        
        var audioLevelsProp = null;
        try { audioLevelsProp = audioGroup.property("Audio Levels"); } catch (e) {}
        if (!audioLevelsProp) {
            for (var i = 1; i <= audioGroup.numProperties; i++) {
                var p = audioGroup.property(i);
                if (p.matchName === "ADBE Audio Levels" || p.name === "Audio Levels") {
                    audioLevelsProp = p;
                    break;
                }
            }
        }
        if (!audioLevelsProp) {
            throw new Error("Audio Levels property not found on layer '" + layer.name + "'.");
        }

        var level      = (args.level      !== undefined && args.level      !== null) ? Number(args.level)      : null;
        var leftLevel  = (args.leftLevel  !== undefined && args.leftLevel  !== null) ? Number(args.leftLevel)  : level;
        var rightLevel = (args.rightLevel !== undefined && args.rightLevel !== null) ? Number(args.rightLevel) : level;

        if (leftLevel === null && rightLevel === null) {
            throw new Error("Provide level (both channels), leftLevel, or rightLevel in dB.");
        }
        if (leftLevel  === null) { leftLevel  = rightLevel; }
        if (rightLevel === null) { rightLevel = leftLevel;  }

        var levelsValue = [leftLevel, rightLevel];

        if (args.timeInSeconds !== undefined && args.timeInSeconds !== null) {
            if (!audioLevelsProp.canVaryOverTime) {
                throw new Error("Audio Levels property cannot be keyframed on this layer.");
            }
            audioLevelsProp.setValueAtTime(Number(args.timeInSeconds), levelsValue);
        } else {
            audioLevelsProp.setValue(levelsValue);
        }

        return JSON.stringify({
            status: "success",
            message: "Audio levels set successfully",
            composition: { name: resolved.comp.name, index: resolved.compIndex },
            layer: { name: layer.name, index: layer.index },
            audioLevels: {
                left: leftLevel,
                right: rightLevel,
                timeInSeconds: (args.timeInSeconds !== undefined && args.timeInSeconds !== null) ? Number(args.timeInSeconds) : null
            }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

function removeLayerEffect(args) {
    try {
        var resolved = resolveCompAndLayer(args || {});
        var effectsGroup = resolved.layer.property("Effects");

        if (!effectsGroup || effectsGroup.numProperties === 0) {
            return JSON.stringify({
                status: "success",
                message: "Layer has no effects to remove",
                removedCount: 0
            }, null, 2);
        }

        var removeAll = !!args.removeAll;
        var removedEffects = [];

        if (removeAll) {
            for (var i = effectsGroup.numProperties; i >= 1; i--) {
                var current = effectsGroup.property(i);
                removedEffects.push({
                    index: current.propertyIndex,
                    name: current.name,
                    matchName: current.matchName
                });
                current.remove();
            }
        } else {
            var effect = resolveEffectOnLayer(resolved.layer, args || {});
            removedEffects.push({
                index: effect.propertyIndex,
                name: effect.name,
                matchName: effect.matchName
            });
            effect.remove();
        }

        return JSON.stringify({
            status: "success",
            message: "Effect removal completed",
            composition: {
                name: resolved.comp.name,
                index: resolved.compIndex
            },
            layer: {
                name: resolved.layer.name,
                index: resolved.layerIndex
            },
            removedCount: removedEffects.length,
            removedEffects: removedEffects
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}


function applyEffectTemplate(args) {
    try {
        
        var compIndex = args.compIndex || 1; 
        var layerIndex = args.layerIndex || 1; 
        var templateName = args.templateName; 
        var customSettings = args.customSettings || {}; 
        
        if (!templateName) {
            throw new Error("You must specify a templateName");
        }
        
        
        var comp = app.project.item(compIndex);
        if (!comp || !(comp instanceof CompItem)) {
            throw new Error("Composition not found at index " + compIndex);
        }
        
        
        var layer = comp.layer(layerIndex);
        if (!layer) {
            throw new Error("Layer not found at index " + layerIndex + " in composition '" + comp.name + "'");
        }
        
        
        var templates = {
            
            "gaussian-blur": {
                effectMatchName: "ADBE Gaussian Blur 2",
                settings: {
                    "Blurriness": customSettings.blurriness || 20
                }
            },
            "directional-blur": {
                effectMatchName: "ADBE Directional Blur",
                settings: {
                    "Direction": customSettings.direction || 0,
                    "Blur Length": customSettings.length || 10
                }
            },
            
            
            "color-balance": {
                effectMatchName: "ADBE Color Balance (HLS)",
                settings: {
                    "Hue": customSettings.hue || 0,
                    "Lightness": customSettings.lightness || 0,
                    "Saturation": customSettings.saturation || 0
                }
            },
            "brightness-contrast": {
                effectMatchName: "ADBE Brightness & Contrast 2",
                settings: {
                    "Brightness": customSettings.brightness || 0,
                    "Contrast": customSettings.contrast || 0,
                    "Use Legacy": false
                }
            },
            "curves": {
                effectMatchName: "ADBE CurvesCustom",
                
            },
            
            
            "glow": {
                effectMatchName: "ADBE Glow",
                settings: {
                    "Glow Threshold": customSettings.threshold || 50,
                    "Glow Radius": customSettings.radius || 15,
                    "Glow Intensity": customSettings.intensity || 1
                }
            },
            "drop-shadow": {
                effectMatchName: "ADBE Drop Shadow",
                settings: {
                    "Shadow Color": customSettings.color || [0, 0, 0, 1],
                    "Opacity": customSettings.opacity || 50,
                    "Direction": customSettings.direction || 135,
                    "Distance": customSettings.distance || 10,
                    "Softness": customSettings.softness || 10
                }
            },
            
            
            "cinematic-look": {
                effects: [
                    {
                        effectMatchName: "ADBE CurvesCustom",
                        settings: {}
                    },
                    {
                        effectMatchName: "ADBE Vibrance",
                        settings: {
                            "Vibrance": 15,
                            "Saturation": -5
                        }
                    }
                ]
            },
            "text-pop": {
                effects: [
                    {
                        effectMatchName: "ADBE Drop Shadow",
                        settings: {
                            "Shadow Color": [0, 0, 0, 1],
                            "Opacity": 75,
                            "Distance": 5,
                            "Softness": 10
                        }
                    },
                    {
                        effectMatchName: "ADBE Glow",
                        settings: {
                            "Glow Threshold": 50,
                            "Glow Radius": 10,
                            "Glow Intensity": 1.5
                        }
                    }
                ]
            }
        };
        
        
        var template = templates[templateName];
        if (!template) {
            var templateNames = [];
            for (var templateKey in templates) {
                if (templates.hasOwnProperty(templateKey)) {
                    templateNames.push(templateKey);
                }
            }
            var availableTemplates = templateNames.join(", ");
            throw new Error("Template '" + templateName + "' not found. Available templates: " + availableTemplates);
        }
        
        var appliedEffects = [];
        
        
        if (template.effectMatchName) {
            
            var effect = layer.Effects.addProperty(template.effectMatchName);
            
            
            for (var propName in template.settings) {
                try {
                    var property = effect.property(propName);
                    if (property) {
                        property.setValue(template.settings[propName]);
                    }
                } catch (e) {
                    $.writeln("Warning: Could not set " + propName + " on effect " + effect.name + ": " + e);
                }
            }
            
            appliedEffects.push({
                name: effect.name,
                matchName: effect.matchName
            });
        } else if (template.effects) {
            
            for (var i = 0; i < template.effects.length; i++) {
                var effectData = template.effects[i];
                var effect = layer.Effects.addProperty(effectData.effectMatchName);
                
                
                for (var propName in effectData.settings) {
                    try {
                        var property = effect.property(propName);
                        if (property) {
                            property.setValue(effectData.settings[propName]);
                        }
                    } catch (e) {
                        $.writeln("Warning: Could not set " + propName + " on effect " + effect.name + ": " + e);
                    }
                }
                
                appliedEffects.push({
                    name: effect.name,
                    matchName: effect.matchName
                });
            }
        }
        
        return JSON.stringify({
            status: "success",
            message: "Effect template '" + templateName + "' applied successfully",
            appliedEffects: appliedEffects,
            layer: {
                name: layer.name,
                index: layerIndex
            },
            composition: {
                name: comp.name,
                index: compIndex
            }
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            status: "error",
            message: error.toString()
        }, null, 2);
    }
}




function bridgeTestEffects(args) {
    try {
        var compIndex = (args && args.compIndex) ? args.compIndex : 1;
        var layerIndex = (args && args.layerIndex) ? args.layerIndex : 1;

        
        var blurRes = JSON.parse(applyEffect({
            compIndex: compIndex,
            layerIndex: layerIndex,
            effectMatchName: "ADBE Gaussian Blur 2",
            effectSettings: { "Blurriness": 5 }
        }));

        
        var shadowRes = JSON.parse(applyEffectTemplate({
            compIndex: compIndex,
            layerIndex: layerIndex,
            templateName: "drop-shadow"
        }));

        return JSON.stringify({
            status: "success",
            message: "Bridge test effects applied.",
            results: [blurRes, shadowRes]
        }, null, 2);
    } catch (e) {
        return JSON.stringify({ status: "error", message: e.toString() }, null, 2);
    }
}


if (typeof JSON === "undefined") {
    JSON = {};
}
if (typeof JSON.parse !== "function") {
    JSON.parse = function (text) {
        
        return eval("(" + text + ")");
    };
}
if (typeof JSON.stringify !== "function") {
    (function () {
        function esc(str) {
            return (str + "")
                .replace(/\\/g, "\\\\")
                .replace(/"/g, '\\"')
                .replace(/\n/g, "\\n")
                .replace(/\r/g, "\\r")
                .replace(/\t/g, "\\t");
        }
        function toJSON(val) {
            if (val === null) return "null";
            var t = typeof val;
            if (t === "number" || t === "boolean") return String(val);
            if (t === "string") return '"' + esc(val) + '"';
            if (val instanceof Array) {
                var a = [];
                for (var i = 0; i < val.length; i++) a.push(toJSON(val[i]));
                return "[" + a.join(",") + "]";
            }
            if (t === "object") {
                var props = [];
                for (var k in val) {
                    if (val.hasOwnProperty(k) && typeof val[k] !== "function" && typeof val[k] !== "undefined") {
                        props.push('"' + esc(k) + '":' + toJSON(val[k]));
                    }
                }
                return "{" + props.join(",") + "}";
            }
            return "null";
        }
        JSON.stringify = function (value, _replacer, _space) {
            return toJSON(value);
        };
    })();
}
// ExtendScript is ES3: no Date.prototype.toISOString.
if (typeof Date.prototype.toISOString !== "function") {
    Date.prototype.toISOString = function () {
        function pad2(n, w) {
            var s = String(n);
            while (s.length < w) s = "0" + s;
            return s;
        }
        return this.getUTCFullYear() + "-" + pad2(this.getUTCMonth() + 1, 2) + "-" + pad2(this.getUTCDate(), 2) + "T" +
            pad2(this.getUTCHours(), 2) + ":" + pad2(this.getUTCMinutes(), 2) + ":" + pad2(this.getUTCSeconds(), 2) + "." +
            pad2(this.getUTCMilliseconds(), 3) + "Z";
    };
}
// === BEGIN PATH POLICY ===
// Pure ES3, no AE APIs: the same text is loaded by the Node unit tests (test/pathPolicy.test.mjs).
var MCPPathPolicy = (function () {
    // Absolute Windows path -> canonical lowercase form with "/" separators, or null if not absolute/invalid.
    function normalize(p) {
        if (p === null || p === undefined) return null;
        var s = String(p).replace(/\\/g, "/");
        if (s.length === 0) return null;
        var prefix;
        var rest;
        var m = /^([a-zA-Z]):(\/.*)?$/.exec(s);
        if (m) {
            prefix = m[1].toLowerCase() + ":";
            rest = m[2] || "/";
        } else if (/^\/\/[^\/]+\/[^\/]+/.test(s)) {
            var parts = s.substring(2).split("/");
            prefix = "//" + parts[0].toLowerCase() + "/" + parts[1].toLowerCase();
            rest = "/" + parts.slice(2).join("/");
        } else if (/^\/[a-zA-Z](\/|$)/.test(s)) {
            // ExtendScript URI form: /d/Projects/MyFilm
            prefix = s.charAt(1).toLowerCase() + ":";
            rest = s.substring(2) || "/";
        } else {
            return null;
        }
        var segs = rest.split("/");
        var out = [];
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            if (seg === "" || seg === ".") continue;
            if (seg === "..") {
                if (out.length === 0) return null;
                out.pop();
                continue;
            }
            out.push(seg.toLowerCase());
        }
        return prefix + "/" + out.join("/");
    }

    // True when candidate is the folder itself or anything beneath it.
    function isInside(folder, candidate) {
        var f = normalize(folder);
        var c = normalize(candidate);
        if (f === null || c === null) return false;
        if (f.charAt(f.length - 1) === "/") f = f.substring(0, f.length - 1);
        return c === f || c.indexOf(f + "/") === 0;
    }

    // Static scan for calls AE won't let us intercept at runtime. Returns a reason string, or null if clean.
    function scanCode(code) {
        var s = String(code).replace(/sandbox\s*\.\s*\w+\s*\(/g, "sandbox_call(");
        var rules = [
            [/callSystem/, "system.callSystem is blocked"],
            [/\.save\s*\(\s*[^\s)]/, "app.project.save(path) is blocked; use sandbox.saveAs(path)"],
            [/\.render\s*\(/, "renderQueue.render() is blocked; use sandbox.render()"],
            [/queueInAME/, "queueInAME is blocked; use sandbox.render()"],
            [/\.saveFrameToPng\s*\(/, "saveFrameToPng is blocked; use sandbox.saveFrameToPng(comp, time, path)"],
            [/\.execute\s*\(\s*\)/, "File.execute() is blocked"],
            [/saveSetting|MCPBridgeSandbox|SANDBOX_SECTION|MCPPathPolicy|WriteGuards|pauseCheckbox|__mcp/, "Changing the bridge's settings, folder or guards from a script is blocked"],
            // Code loaded these ways would never be scanned; use runScriptFile instead.
            [/evalFile|#include|(^|[^\w.$])eval\s*\(/, "$.evalFile, #include and eval() are blocked; run other scripts with runScriptFile"]
        ];
        for (var i = 0; i < rules.length; i++) {
            if (rules[i][0].test(s)) return rules[i][1];
        }
        return null;
    }

    return { normalize: normalize, isInside: isInside, scanCode: scanCode };
})();
// === END PATH POLICY ===

var aeVersion = parseFloat(app.version);
// Docked when opened from the Window menu; a floating palette only when run another way (File > Scripts).
var isDocked = (typeof Panel !== "undefined") && (thisObj instanceof Panel);
var panel = isDocked ? thisObj : new Window("palette", "MCP Bridge Auto", undefined, { resizeable: true });
panel.orientation = "column";
panel.alignChildren = ["fill", "top"];
panel.spacing = isDocked ? 6 : 10;
panel.margins = isDocked ? 8 : 16;
var statusText = panel.add("statictext", undefined, "Waiting for commands...");
statusText.alignment = ["fill", "top"];
var logPanel = panel.add("panel", undefined, "Command Log");
logPanel.orientation = "column";
logPanel.alignChildren = ["fill", "fill"];
var logText = logPanel.add("edittext", undefined, "", {multiline: true, readonly: true});
logText.preferredSize.height = isDocked ? 140 : 200;
logPanel.alignment = ["fill", "fill"];
// --- Sandbox: the one folder Claude may modify, chosen per project by the user ---
var SANDBOX_SECTION = "MCPBridgeSandbox";
var sandboxPanel = panel.add("panel", undefined, "Claude's writable folder");
sandboxPanel.orientation = "column";
sandboxPanel.alignChildren = ["fill", "top"];
var projectLabel = sandboxPanel.add("statictext", undefined, "Project:");
var folderLabel = sandboxPanel.add("statictext", undefined, "Folder: Not set");
projectLabel.preferredSize.width = 380;
folderLabel.preferredSize.width = 380;
var sandboxButtons = sandboxPanel.add("group");
sandboxButtons.orientation = "row";
var browseButton = sandboxButtons.add("button", undefined, "Browse...");
var clearButton = sandboxButtons.add("button", undefined, "Clear");
var pauseCheckbox = panel.add("checkbox", undefined, "Pause Claude (refuse all commands)");
pauseCheckbox.value = false;
var checkInterval = 500;
var isChecking = false;
var lastProcessedId = null;
var lastUiState = null;

function currentProjectPath() {
    return (app.project && app.project.file) ? app.project.file.fsName : "";
}

function sandboxKey(projectPath) {
    return encodeURIComponent(MCPPathPolicy.normalize(projectPath));
}

// The folder stored for the open project, or null (unsaved project, or never chosen).
function getSandboxFolder() {
    var p = currentProjectPath();
    if (!p) return null;
    var key = sandboxKey(p);
    if (!app.settings.haveSetting(SANDBOX_SECTION, key)) return null;
    var v = app.settings.getSetting(SANDBOX_SECTION, key);
    return v ? v : null;
}

function refreshSandboxUI() {
    var p = currentProjectPath();
    var f = getSandboxFolder();
    var state = p + "|" + f;
    if (state === lastUiState) return;
    lastUiState = state;
    projectLabel.text = "Project: " + (p ? fileDisplayName(app.project.file) : "Untitled (save it to choose a folder)");
    folderLabel.text = "Folder: " + (f ? f : "Not set - Claude can't write files or run scripts");
    browseButton.enabled = !!p;
    clearButton.enabled = !!f;
}

browseButton.onClick = function () {
    var p = currentProjectPath();
    if (!p) return;
    var start = getSandboxFolder() ? new Folder(getSandboxFolder()) : app.project.file.parent;
    var picked = start.selectDlg("Choose the folder Claude may modify for " + fileDisplayName(app.project.file));
    if (picked) {
        app.settings.saveSetting(SANDBOX_SECTION, sandboxKey(p), picked.fsName);
        logToPanel("Writable folder set: " + picked.fsName);
        refreshSandboxUI();
    }
};

clearButton.onClick = function () {
    var p = currentProjectPath();
    if (!p) return;
    app.settings.saveSetting(SANDBOX_SECTION, sandboxKey(p), "");
    logToPanel("Writable folder cleared for " + fileDisplayName(app.project.file));
    refreshSandboxUI();
};
// Bridge folder: %AE_MCP_BRIDGE_DIR%, else %USERPROFILE%\ae-mcp-bridge (local profile, never OneDrive).
function getBridgeFolder() {
    var dir = $.getenv("AE_MCP_BRIDGE_DIR");
    if (!dir) {
        var userFolder = new Folder($.getenv("USERPROFILE") || Folder.myDocuments.fsName);
        dir = userFolder.fsName + "/ae-mcp-bridge";
    }
    var bridgeFolder = new Folder(dir);
    if (!bridgeFolder.exists) {
        bridgeFolder.create();
    }
    return bridgeFolder;
}
function getCommandFilePath() {
    return getBridgeFolder().fsName + "/ae_command.json";
}
function getResultFilePath() {
    return getBridgeFolder().fsName + "/ae_mcp_result.json";
}
function findCompByName(name) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === name) { return it; }
    }
    throw new Error("Composition not found: " + name);
}

// args: compName, duration, extendLayers (sets every layer that ended at the old comp end to the new end)
function setCompDuration(args) {
    try {
        var comp = findCompByName(args.compName);
        var oldDur = comp.duration;
        comp.duration = args.duration;
        var extended = [];
        if (args.extendLayers) {
            for (var i = 1; i <= comp.numLayers; i++) {
                var L = comp.layer(i);
                if (Math.abs(L.outPoint - oldDur) < 0.001) { L.outPoint = args.duration; extended.push(L.name); }
            }
        }
        return JSON.stringify({ status: "success", comp: comp.name, oldDuration: oldDur, duration: comp.duration, extendedLayers: extended }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

// args: compName, layerName, effectName, propertyName, keyIndex (default 1), newTime. Keeps value and interpolation.
function moveEffectKeyframe(args) {
    try {
        var comp = findCompByName(args.compName);
        var layer = comp.layer(args.layerName);
        if (!layer) { throw new Error("Layer not found: " + args.layerName); }
        var prop = layer.property("Effects").property(args.effectName).property(args.propertyName);
        var k = args.keyIndex || 1;
        var oldTime = prop.keyTime(k), val = prop.keyValue(k);
        var inI = prop.keyInInterpolationType(k), outI = prop.keyOutInterpolationType(k);
        prop.removeKey(k);
        var nk = prop.addKey(args.newTime);
        prop.setValueAtKey(nk, val);
        prop.setInterpolationTypeAtKey(nk, inI, outI);
        return JSON.stringify({ status: "success", layer: layer.name, oldTime: oldTime, newTime: prop.keyTime(nk), numKeys: prop.numKeys }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

// args: compName, path, name, position, scale, duration
function importFileToComp(args) {
    try {
        var comp = findCompByName(args.compName);
        var f = new File(args.path);
        if (!f.exists) { throw new Error("File not found: " + args.path); }
        var item = app.project.importFile(new ImportOptions(f));
        var L = comp.layers.add(item);
        if (args.name) { L.name = args.name; }
        if (args.position) { L.property("Position").setValue(args.position); }
        if (args.scale) { L.property("Scale").setValue(args.scale); }
        if (args.duration) { L.outPoint = args.duration; }
        return JSON.stringify({ status: "success", layer: L.name, index: L.index, width: item.width, height: item.height }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

// args: compName, layerName, and afterName (place directly below) or beforeName (directly above)
function moveLayer(args) {
    try {
        var comp = findCompByName(args.compName);
        var L = comp.layer(args.layerName);
        if (!L) { throw new Error("Layer not found: " + args.layerName); }
        if (args.afterName) { L.moveAfter(comp.layer(args.afterName)); }
        else if (args.beforeName) { L.moveBefore(comp.layer(args.beforeName)); }
        else { throw new Error("Pass afterName or beforeName"); }
        return JSON.stringify({ status: "success", layer: L.name, index: L.index }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

// args: compName, layerName, size [w,h], roundness (optional). Edits the first rectangle in a shape layer.
function setRectSize(args) {
    try {
        var comp = findCompByName(args.compName);
        var L = comp.layer(args.layerName);
        if (!L) { throw new Error("Layer not found: " + args.layerName); }
        var rect = L.property("Contents").property(1).property("Contents").property("ADBE Vector Shape - Rect");
        if (!rect) { throw new Error("No rectangle in first shape group of " + args.layerName); }
        if (args.size) { rect.property("Size").setValue(args.size); }
        if (args.roundness !== undefined) { rect.property("Roundness").setValue(args.roundness); }
        return JSON.stringify({ status: "success", layer: L.name, size: rect.property("Size").value }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

// args: compName, layerName
function deleteLayer(args) {
    try {
        var comp = findCompByName(args.compName);
        var L = comp.layer(args.layerName);
        if (!L) { throw new Error("Layer not found: " + args.layerName); }
        L.remove();
        return JSON.stringify({ status: "success", deleted: args.layerName, numLayers: comp.numLayers }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

// args: compName, layerName, propertyName, expressionString
function setExpressionByName(args) {
    var comp = findCompByName(args.compName);
    var compIdx = 0;
    for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i) === comp) { compIdx = i; break; } }
    var L = comp.layer(args.layerName);
    if (!L) { return JSON.stringify({ success: false, message: "Layer not found: " + args.layerName }); }
    return setLayerExpression(compIdx, L.index, args.propertyName, args.expressionString);
}

function saveProject(args) {
    try {
        if (args.path) {
            var f = new File(args.path);
            // Saving to a new path must land in the writable folder; saving the open project in place is always allowed.
            var sameAsOpen = MCPPathPolicy.normalize(f.fsName) === MCPPathPolicy.normalize(currentProjectPath());
            var folder = getSandboxFolder();
            if (!sameAsOpen && !(folder && MCPPathPolicy.isInside(folder, f.fsName))) {
                return JSON.stringify({ status: "error", refused: true, code: folder ? "OUTSIDE_FOLDER" : "NO_FOLDER",
                    message: "Save path is outside the writable folder (" + (folder || "not set") + "): " + f.fsName });
            }
            if (f.exists && !args.overwrite && !sameAsOpen) {
                return JSON.stringify({ status: "error", code: "FILE_EXISTS", message: "File already exists: " + f.fsName });
            }
            app.project.save(f);
            if (!sameAsOpen) { inheritSandboxFolder(folder); }
        } else {
            if (!app.project.file) { throw new Error("Project has never been saved; pass a path."); }
            app.project.save();
        }
        return JSON.stringify({ status: "success", savedTo: app.project.file.fsName, numItems: app.project.numItems }, null, 2);
    } catch (error) {
        return JSON.stringify({ status: "error", message: error.toString() }, null, 2);
    }
}

function getProjectInfo() {
    var project = app.project;
    var result = {
        projectName: project.file ? fileDisplayName(project.file) : "Untitled Project",
        path: project.file ? project.file.fsName : "",
        numItems: project.numItems,
        bitsPerChannel: project.bitsPerChannel,
        timeMode: project.timeDisplayType === TimeDisplayType.FRAMES ? "Frames" : "Timecode",
        items: []
    };
    var countByType = {
        compositions: 0,
        footage: 0,
        folders: 0,
        solids: 0
    };
    for (var i = 1; i <= Math.min(project.numItems, 50); i++) {
        var item = project.item(i);
        var itemType = "";
        
        if (item instanceof CompItem) {
            itemType = "Composition";
            countByType.compositions++;
        } else if (item instanceof FolderItem) {
            itemType = "Folder";
            countByType.folders++;
        } else if (item instanceof FootageItem) {
            if (item.mainSource instanceof SolidSource) {
                itemType = "Solid";
                countByType.solids++;
            } else {
                itemType = "Footage";
                countByType.footage++;
            }
        }
        
        result.items.push({
            id: item.id,
            name: item.name,
            type: itemType
        });
    }
    
    result.itemCounts = countByType;
    if (app.project.activeItem instanceof CompItem) {
        var ac = app.project.activeItem;
        result.activeComp = {
            id: ac.id,
            name: ac.name,
            width: ac.width,
            height: ac.height,
            duration: ac.duration,
            frameRate: ac.frameRate,
            numLayers: ac.numLayers
        };
    }

    return JSON.stringify(result, null, 2);
}

function listCompositions() {
    var project = app.project;
    var result = {
        compositions: []
    };
    for (var i = 1; i <= project.numItems; i++) {
        var item = project.item(i);
        if (item instanceof CompItem) {
            result.compositions.push({
                id: item.id,
                name: item.name,
                duration: item.duration,
                frameRate: item.frameRate,
                width: item.width,
                height: item.height,
                numLayers: item.numLayers
            });
        }
    }
    
    return JSON.stringify(result, null, 2);
}

function getLayerInfo() {
    var project = app.project;
    var result = {
        layers: []
    };
    var activeComp = null;
    if (app.project.activeItem instanceof CompItem) {
        activeComp = app.project.activeItem;
    } else {
        return JSON.stringify({ error: "No active composition" }, null, 2);
    }
    for (var i = 1; i <= activeComp.numLayers; i++) {
        var layer = activeComp.layer(i);
        var layerInfo = {
            index: layer.index,
            name: layer.name,
            enabled: layer.enabled,
            locked: layer.locked,
            inPoint: layer.inPoint,
            outPoint: layer.outPoint
        };
        
        result.layers.push(layerInfo);
    }
    
    return JSON.stringify(result, null, 2);
}
// --- Command gate: Pause, then project confirmation, then project match ---
var GATE_EXEMPT = { getSandboxFolder: true, getProjectInfo: true };

// File.name is URI-encoded ("SH%20048.aep"); this is the readable form.
function fileDisplayName(f) {
    try {
        return decodeURI(f.name);
    } catch (e) {
        return f.name;
    }
}

function samePath(a, b) {
    if (!a || !b) return !a && !b;
    return MCPPathPolicy.normalize(a) === MCPPathPolicy.normalize(b);
}

// After Claude saves the project to a new path inside the folder, the new project keeps the user's folder choice.
function inheritSandboxFolder(folder) {
    var p = currentProjectPath();
    if (p && folder && MCPPathPolicy.isInside(folder, p)) {
        app.settings.saveSetting(SANDBOX_SECTION, sandboxKey(p), folder);
        refreshSandboxUI();
    }
}

// ES3 Date.parse can't read ISO strings. Returns ms since epoch, or null.
function parseIsoTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(String(s));
    if (!m) return null;
    var ms = m[7] ? parseInt((m[7] + "00").substring(0, 3), 10) : 0;
    return Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
        parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10), ms);
}

var STALE_AFTER_MS = 120000;

function displayProjectName(projectPath) {
    if (!projectPath) return "an untitled project";
    var parts = String(projectPath).replace(/\\/g, "/").split("/");
    return parts[parts.length - 1];
}

function refusal(code, message, extra) {
    var r = { status: "error", refused: true, code: code, message: message };
    if (extra) {
        for (var k in extra) {
            if (extra.hasOwnProperty(k)) r[k] = extra[k];
        }
    }
    return r;
}

// Returns a refusal result object, or null when the command may run.
function gateCommand(commandData) {
    if (GATE_EXEMPT[commandData.command] === true) return null;
    if (pauseCheckbox.value) {
        return refusal("PAUSED", "Paused: the user has paused Claude in the MCP Bridge panel. Ask the user to untick Pause, then retry.");
    }
    var expected = commandData.expectedProject;
    if (expected === undefined || expected === null) {
        return refusal("PROJECT_NOT_CONFIRMED", "No project confirmed yet. Call get-sandbox-folder to confirm which project is open in After Effects, then retry.");
    }
    var open = currentProjectPath();
    var nExpected = (expected === "") ? "" : MCPPathPolicy.normalize(expected);
    var nOpen = (open === "") ? "" : MCPPathPolicy.normalize(open);
    if (nExpected === null || nExpected !== nOpen) {
        return refusal("PROJECT_MISMATCH",
            "Expected " + displayProjectName(expected) + " but " + displayProjectName(open) + " is open. Confirm with the user, then call get-sandbox-folder to switch.",
            { expectedProject: expected, openProject: open });
    }
    return null;
}

// Read-only, exempt from the gate.
function getSandboxFolderInfo() {
    var p = currentProjectPath();
    var f = getSandboxFolder();
    var exists = f ? new Folder(f).exists : false;
    var paused = !!pauseCheckbox.value;
    return {
        status: "success",
        projectPath: p,
        projectName: p ? fileDisplayName(app.project.file) : "Untitled Project",
        folder: f,
        folderExists: exists,
        paused: paused,
        scriptsEnabled: !!(f && exists && !paused)
    };
}

// --- Result writing ---
// Strips control characters the JSON polyfill doesn't escape.
function cleanString(s) {
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

function toResultObject(result) {
    if (result !== null && typeof result === "object" && !(result instanceof Array)) return result;
    var str = (typeof result === "string") ? result : String(result);
    try {
        var parsed = JSON.parse(str);
        if (parsed !== null && typeof parsed === "object" && !(parsed instanceof Array)) return parsed;
        return { result: parsed };
    } catch (parseError) {
        return { result: cleanString(str) };
    }
}

// tmp -> remove old -> rename. File.rename takes a bare file name.
// startProject: the open project when the command started. _projectChanged is true only for a
// finished, successful command after which a different project is open.
function writeResultAtomic(resultObj, command, commandId, startProject) {
    var openProject = currentProjectPath();
    resultObj._commandId = commandId;
    resultObj._commandExecuted = command;
    resultObj._responseTimestamp = new Date().toISOString();
    resultObj._project = openProject;
    resultObj._projectChanged = resultObj.status !== "error" && resultObj.status !== "running" &&
        !samePath(startProject, openProject);
    var text = JSON.stringify(resultObj, null, 2);
    var targetPath = getResultFilePath();
    var target = new File(targetPath);
    var tmp = new File(targetPath.replace(/\.json$/, ".tmp"));
    tmp.encoding = "UTF-8";
    if (!tmp.open("w")) throw new Error("Failed to open temp result file: " + tmp.fsName);
    tmp.write(text);
    tmp.close();
    var moved = false;
    for (var attempt = 0; attempt < 5 && !moved; attempt++) {
        if (attempt > 0) $.sleep(20);
        if (target.exists && !target.remove()) continue;
        moved = tmp.rename(target.name);
    }
    if (!moved) {
        // Last resort: write in place so a result always exists.
        target.encoding = "UTF-8";
        if (!target.open("w")) throw new Error("Failed to write result file: " + target.fsName);
        target.write(text);
        target.close();
        try { tmp.remove(); } catch (e) {}
        logToPanel("Warning: atomic rename failed, wrote result in place.");
    }
}

// --- Script runner (runScript / runScriptFile) ---
function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = "0" + s;
    return s;
}

function archiveStamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + "-" +
        pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2) + "-" + pad(d.getMilliseconds(), 3);
}

function safeScriptName(name) {
    var s = String(name || "script").replace(/[^A-Za-z0-9_\-]+/g, "-").replace(/^-+|-+$/g, "");
    if (s.length > 60) s = s.substring(0, 60);
    return s || "script";
}

function blockedError(message, code) {
    var e = new Error(message);
    e.mcpCode = code;
    return e;
}

function scriptsFolder(folder) {
    var f = new Folder(folder + "/mcp-scripts");
    if (!f.exists) f.create();
    return f;
}

// Relative paths resolve against the folder; absolute paths are returned unchanged.
function resolveInFolder(folder, p) {
    if (MCPPathPolicy.normalize(p) !== null) return String(p);
    return new File(folder + "/" + p).fsName;
}

// Converts a script's return value to something JSON.stringify can always handle.
function toJsonSafe(value, depth) {
    if (value === undefined || value === null) return null;
    var t = typeof value;
    if (t === "boolean") return value;
    if (t === "number") return isFinite(value) ? value : null;
    if (t === "string") return cleanString(value);
    if (t === "function") return null;
    if (depth >= 8) return "[depth limit]";
    if (value instanceof Array) {
        var arr = [];
        for (var i = 0; i < value.length; i++) arr.push(toJsonSafe(value[i], depth + 1));
        return arr;
    }
    try {
        if (value instanceof Date) return value.toISOString();
        if (value.constructor === Object) {
            var obj = {};
            for (var k in value) {
                if (value.hasOwnProperty(k) && typeof value[k] !== "function") obj[k] = toJsonSafe(value[k], depth + 1);
            }
            return obj;
        }
        // Host objects (CompItem, File, ...) and other class instances.
        return cleanString(String(value));
    } catch (e) {
        return "[unprintable]";
    }
}

// Function-body errors are reported one line high; map to the script's own line numbers.
function scriptErrorLine(e) {
    if (!e || e.mcpCode || typeof e.line !== "number") return null;
    var line = e.line - 1;
    return line < 1 ? 1 : line;
}

function makeSandbox(folder) {
    function checkInside(p, what) {
        if (!MCPPathPolicy.isInside(folder, p)) {
            throw blockedError("Blocked: " + what + " outside the writable folder: " + p, "OUTSIDE_FOLDER");
        }
    }
    return {
        folder: folder,
        path: function (rel) { return resolveInFolder(folder, rel); },
        saveAs: function (p, overwrite) {
            var abs = resolveInFolder(folder, p);
            checkInside(abs, "save as");
            var f = new File(abs);
            if (f.exists && !overwrite) throw blockedError("File already exists: " + f.fsName + " (pass overwrite=true)", "FILE_EXISTS");
            app.project.save(f);
            inheritSandboxFolder(folder);
            return app.project.file ? app.project.file.fsName : f.fsName;
        },
        render: function () {
            var rq = app.project.renderQueue;
            for (var i = 1; i <= rq.numItems; i++) {
                var item = rq.item(i);
                if (item.status !== RQItemStatus.QUEUED) continue;
                for (var j = 1; j <= item.numOutputModules; j++) {
                    var om = item.outputModule(j);
                    if (!om.file) throw blockedError("Blocked: render queue item " + i + " output module " + j + " has no output file", "OUTSIDE_FOLDER");
                    checkInside(om.file.fsName, "render output");
                }
            }
            rq.render();
            return true;
        },
        saveFrameToPng: function (comp, time, p) {
            var abs = resolveInFolder(folder, p);
            checkInside(abs, "saveFrameToPng");
            return comp.saveFrameToPng(time, new File(abs));
        }
    };
}

// Wraps File/Folder write methods; every original is recorded in `installed` for restoreWriteGuards.
function installWriteGuards(folder, installed) {
    function wrap(proto, name, makeGuard) {
        var orig = proto[name];
        if (typeof orig !== "function") return;
        installed.push({ proto: proto, name: name, orig: orig });
        proto[name] = makeGuard(orig);
    }
    function check(p, what) {
        if (!MCPPathPolicy.isInside(folder, p)) {
            throw blockedError("Blocked: " + what + " outside the writable folder: " + p, "OUTSIDE_FOLDER");
        }
    }
    function targetPath(target) {
        return (typeof target === "string") ? new File(target).fsName : target.fsName;
    }
    function siblingPath(item, newName) {
        return item.parent ? item.parent.fsName + "/" + newName : String(newName);
    }
    wrap(File.prototype, "open", function (orig) {
        return function (mode) {
            if (/[wae]/i.test(String(mode || "r"))) check(this.fsName, "File.open(\"" + mode + "\")");
            return orig.apply(this, arguments);
        };
    });
    wrap(File.prototype, "remove", function (orig) {
        return function () {
            check(this.fsName, "File.remove");
            return orig.apply(this, arguments);
        };
    });
    wrap(File.prototype, "rename", function (orig) {
        return function (newName) {
            check(this.fsName, "File.rename");
            check(siblingPath(this, newName), "File.rename");
            return orig.apply(this, arguments);
        };
    });
    wrap(File.prototype, "copy", function (orig) {
        return function (target) {
            check(targetPath(target), "File.copy");
            return orig.apply(this, arguments);
        };
    });
    wrap(File.prototype, "createAlias", function (orig) {
        return function () {
            check(this.fsName, "File.createAlias");
            return orig.apply(this, arguments);
        };
    });
    wrap(File.prototype, "execute", function (orig) {
        return function () {
            throw blockedError("Blocked: File.execute() is not allowed in MCP scripts", "BLOCKED_CALL");
        };
    });
    wrap(Folder.prototype, "create", function (orig) {
        return function () {
            check(this.fsName, "Folder.create");
            return orig.apply(this, arguments);
        };
    });
    wrap(Folder.prototype, "remove", function (orig) {
        return function () {
            check(this.fsName, "Folder.remove");
            return orig.apply(this, arguments);
        };
    });
    wrap(Folder.prototype, "rename", function (orig) {
        return function (newName) {
            check(this.fsName, "Folder.rename");
            check(siblingPath(this, newName), "Folder.rename");
            return orig.apply(this, arguments);
        };
    });
}

function restoreWriteGuards(installed) {
    for (var i = installed.length - 1; i >= 0; i--) {
        try {
            installed[i].proto[installed[i].name] = installed[i].orig;
        } catch (e) {
            logToPanel("CRITICAL: failed to restore " + installed[i].name + ": " + e.toString());
        }
    }
    installed.length = 0;
}

// Copies the saved .aep to <folder>/mcp-scripts/backups/<stamp>_<base>.aep and keeps the newest 10 for that project.
var BACKUPS_TO_KEEP = 10;

function backupProject(folder) {
    var src = app.project.file;
    var base = fileDisplayName(src).replace(/\.aep$/i, "");
    var dir = new Folder(scriptsFolder(folder).fsName + "/backups");
    if (!dir.exists && !dir.create()) throw new Error("Could not create " + dir.fsName);
    var dest = new File(dir.fsName + "/" + archiveStamp(new Date()) + "_" + base + ".aep");
    if (!src.copy(dest.fsName)) {
        throw new Error("Could not copy project to " + dest.fsName + (src.error ? ": " + src.error : ""));
    }
    pruneBackups(dir, base);
    return dest.fsName;
}

function pruneBackups(dir, base) {
    var suffix = "_" + base + ".aep";
    var files = dir.getFiles("*.aep");
    var mine = [];
    for (var i = 0; i < files.length; i++) {
        if (!(files[i] instanceof File)) continue;
        var n = fileDisplayName(files[i]);
        // <yyyymmdd-hhmmss-mmm> is 19 characters, so the names sort oldest-first.
        if (/^\d{8}-\d{6}-\d{3}_/.test(n) && n.substring(19) === suffix) mine.push({ name: n, file: files[i] });
    }
    mine.sort(function (a, b) { return a.name < b.name ? 1 : (a.name > b.name ? -1 : 0); });
    for (var j = BACKUPS_TO_KEEP; j < mine.length; j++) {
        try { mine[j].file.remove(); } catch (e) {}
    }
}

function appendRunLog(folder, name, ok, durationMs, message) {
    try {
        var log = new File(scriptsFolder(folder).fsName + "/run-log.txt");
        log.encoding = "UTF-8";
        if (!log.open("a")) return;
        log.writeln(new Date().toISOString() + "\t" + name + "\t" + (ok ? "success" : "error") + "\t" +
            durationMs + "\t" + String(message || "").replace(/[\t\r\n]+/g, " "));
        log.close();
    } catch (e) {
        logToPanel("Could not write run-log: " + e.toString());
    }
}

// Returns a result object for runScript / runScriptFile.
function runScriptCommand(command, args) {
    var folder = getSandboxFolder();
    if (!folder) {
        return refusal("NO_FOLDER", "No writable folder is set for this project. Ask the user to choose one with Browse... in the MCP Bridge panel (the project must be saved first).");
    }
    if (!new Folder(folder).exists) {
        return refusal("FOLDER_MISSING", "The writable folder no longer exists: " + folder + ". Ask the user to choose it again in the MCP Bridge panel.");
    }

    var code;
    var name;
    var archivedAs = null;
    if (command === "runScriptFile") {
        if (!args.file) return { status: "error", code: "BAD_ARGS", message: "runScriptFile needs a 'file' argument." };
        var scriptPath = resolveInFolder(folder, args.file);
        if (!MCPPathPolicy.isInside(folder, scriptPath)) {
            return refusal("OUTSIDE_FOLDER", "Script file is outside the writable folder (" + folder + "): " + scriptPath);
        }
        var scriptFile = new File(scriptPath);
        if (!scriptFile.exists) return { status: "error", code: "FILE_NOT_FOUND", message: "Script file not found: " + scriptFile.fsName };
        scriptFile.encoding = "UTF-8";
        if (!scriptFile.open("r")) return { status: "error", code: "FILE_NOT_FOUND", message: "Could not open script file: " + scriptFile.fsName };
        code = scriptFile.read();
        scriptFile.close();
        name = safeScriptName(fileDisplayName(scriptFile).replace(/\.(jsx|js)$/i, ""));
    } else {
        if (typeof args.code !== "string") return { status: "error", code: "BAD_ARGS", message: "runScript needs a 'code' string argument." };
        code = args.code;
        name = safeScriptName(args.name);
    }

    var blockedReason = MCPPathPolicy.scanCode(code);
    if (blockedReason) {
        return refusal("BLOCKED_CALL", "Blocked: " + blockedReason + ".");
    }

    if (command === "runScript") {
        var archive = new File(scriptsFolder(folder).fsName + "/" + archiveStamp(new Date()) + "_" + name + ".jsx");
        archive.encoding = "UTF-8";
        if (!archive.open("w")) return { status: "error", code: "ARCHIVE_FAILED", message: "Could not write archive file: " + archive.fsName };
        archive.write(code);
        archive.close();
        archivedAs = archive.fsName;
    }

    if (app.project.file) {
        try {
            app.project.save();
        } catch (saveError) {
            var saveResult = { status: "error", code: "SAVE_FAILED", message: "Save before run failed, script not run: " + saveError.toString(), line: null };
            if (archivedAs) saveResult.archivedAs = archivedAs;
            return saveResult;
        }
    }

    // Rolling backup of the just-saved .aep; a failure is reported but doesn't block the run.
    var backupPath = null;
    var backupWarning = null;
    if (app.project.file) {
        try {
            backupPath = backupProject(folder);
        } catch (backupError) {
            backupWarning = "Backup failed: " + cleanString(backupError.toString());
            logToPanel(backupWarning);
        }
    }

    var startProject = currentProjectPath();
    var sandbox = makeSandbox(folder);
    var systemStub = {
        callSystem: function () {
            throw blockedError("Blocked: system.callSystem is not allowed in MCP scripts", "BLOCKED_CALL");
        }
    };
    var startTime = new Date().getTime();
    var fn = null;
    var runError = null;
    var returnValue;
    var installed = [];
    var undoOpen = false;

    try {
        fn = __mcpCompileUserCode(code);
    } catch (syntaxError) {
        runError = syntaxError;
    }

    if (fn) {
        try {
            installWriteGuards(folder, installed);
            app.beginUndoGroup("MCP: " + name);
            undoOpen = true;
            returnValue = fn(sandbox, systemStub);
        } catch (e) {
            runError = e;
        } finally {
            if (undoOpen) {
                try { app.endUndoGroup(); } catch (undoError) {}
            }
            restoreWriteGuards(installed);
        }
    }
    var durationMs = new Date().getTime() - startTime;

    var violations = [];
    var endProject = currentProjectPath();
    if (endProject && MCPPathPolicy.normalize(endProject) !== MCPPathPolicy.normalize(startProject) &&
            !MCPPathPolicy.isInside(folder, endProject)) {
        violations.push("Project file moved outside the writable folder: " + endProject);
    }

    var result;
    if (runError) {
        var isError = runError instanceof Error;
        var message = cleanString(isError ? runError.toString() : String(runError));
        result = { status: "error", message: message, line: isError ? scriptErrorLine(runError) : null };
        if (!fn) result.code = "SYNTAX_ERROR";
        else result.code = (isError && runError.mcpCode) ? runError.mcpCode : "SCRIPT_ERROR";
        if (archivedAs) result.archivedAs = archivedAs;
        if (violations.length) result.sandboxViolations = violations;
        appendRunLog(folder, name, false, durationMs, message);
    } else {
        result = {
            status: "success",
            returnValue: toJsonSafe(returnValue, 0),
            durationMs: durationMs,
            archivedAs: archivedAs,
            sandboxViolations: violations
        };
        appendRunLog(folder, name, true, durationMs, violations.length ? violations.join("; ") : "");
    }
    result.backupPath = backupPath;
    if (backupWarning) result.backupWarning = backupWarning;
    return result;
}

// --- Dispatch ---
function executeCommand(commandData) {
    var command = commandData.command;
    var args = commandData.args || {};
    var commandId = String(commandData.id || commandData.timestamp || "");
    var startProject = currentProjectPath();
    var result;

    try {
        logToPanel("Command: " + command);
        // UI refresh is cosmetic and must never stop a command; docked Panels have no update().
        try {
            statusText.text = "Running: " + command;
            if (typeof panel.update === "function") panel.update();
        } catch (uiError) {}

        var written = parseIsoTime(commandData.timestamp);
        var ageMs = (written === null) ? 0 : new Date().getTime() - written;
        var refused = (ageMs > STALE_AFTER_MS)
            ? refusal("STALE", "This command was written " + Math.round(ageMs / 1000) + " s ago, so it was not run (commands older than " +
                (STALE_AFTER_MS / 1000) + " s are dropped). Check the project state, then send it again if it is still wanted.")
            : gateCommand(commandData);
        if (refused) {
            result = refused;
            logToPanel("Refused " + command + " (" + refused.code + ")");
        } else {
            switch (command) {
                case "getSandboxFolder":
                    result = getSandboxFolderInfo();
                    break;
                case "runScript":
                case "runScriptFile":
                    writeResultAtomic({ status: "running", message: "Script is running in After Effects." }, command, commandId, startProject);
                    result = runScriptCommand(command, args);
                    break;
                case "getProjectInfo":
                    result = getProjectInfo();
                    break;
                case "setCompDuration":
                    result = setCompDuration(args);
                    break;
                case "moveEffectKeyframe":
                    result = moveEffectKeyframe(args);
                    break;
                case "importFileToComp":
                    result = importFileToComp(args);
                    break;
                case "moveLayer":
                    result = moveLayer(args);
                    break;
                case "setRectSize":
                    result = setRectSize(args);
                    break;
                case "deleteLayer":
                    result = deleteLayer(args);
                    break;
                case "setExpressionByName":
                    result = setExpressionByName(args);
                    break;
                case "saveProject":
                    result = saveProject(args);
                    break;
                case "listCompositions":
                    result = listCompositions();
                    break;
                case "getLayerInfo":
                    result = getLayerInfo();
                    break;
                case "createComposition":
                    result = createComposition(args);
                    break;
                case "createTextLayer":
                    result = createTextLayer(args);
                    break;
                case "createShapeLayer":
                    result = createShapeLayer(args);
                    break;
                case "createSolidLayer":
                    result = createSolidLayer(args);
                    break;
                case "setLayerProperties":
                    result = setLayerProperties(args);
                    break;
                case "setLayerKeyframe":
                    result = setLayerKeyframe(args.compIndex, args.layerIndex, args.propertyName, args.timeInSeconds, args.value);
                    break;
                case "setLayerExpression":
                    result = setLayerExpression(args.compIndex, args.layerIndex, args.propertyName, args.expressionString);
                    break;
                case "applyEffect":
                    result = applyEffect(args);
                    break;
                case "applyEffectTemplate":
                    result = applyEffectTemplate(args);
                    break;
                case "listLayerEffects":
                    result = listLayerEffects(args);
                    break;
                case "listAvailableEffects":
                    result = listAvailableEffects(args);
                    break;
                case "setEffectProperty":
                    result = setEffectProperty(args);
                    break;
                case "setEffectKeyframe":
                    result = setEffectKeyframe(args);
                    break;
                case "applyLayerPreset":
                    result = applyLayerPreset(args);
                    break;
                case "createAdjustmentLayer":
                    result = createAdjustmentLayer(args);
                    break;
                case "centerLayers":
                    result = centerLayers(args);
                    break;
                case "getLayerClipFrames":
                    result = getLayerClipFrames(args);
                    break;
                case "getLayerAudioInfo":
                    result = getLayerAudioInfo(args);
                    break;
                case "addMarkersFromArray":
                    result = addMarkersFromArray(args);
                    break;
                case "addMarker":
                    result = addMarker(args);
                    break;
                case "setLayerAudioLevels":
                    result = setLayerAudioLevels(args);
                    break;
                case "removeLayerEffect":
                    result = removeLayerEffect(args);
                    break;
                case "bridgeTestEffects":
                    result = bridgeTestEffects(args);
                    break;
                default:
                    result = { status: "error", error: "Unknown command: " + command, message: "Unknown command: " + command };
            }
        }
    } catch (error) {
        logToPanel("ERROR in " + command + ": " + error.toString() + (error.line ? " (line: " + error.line + ")" : ""));
        result = {
            status: "error",
            command: command,
            message: cleanString(error.toString()),
            line: error.line,
            fileName: error.fileName
        };
    }

    var resultObj = toResultObject(result);
    var failed = resultObj.status === "error";
    // Write the result before marking the command done, so a "completed" command always has a result.
    try {
        writeResultAtomic(resultObj, command, commandId, startProject);
    } catch (writeError) {
        logToPanel("CRITICAL: failed to write result file: " + writeError.toString());
        failed = true;
    }
    updateCommandStatus(failed ? "error" : "completed", commandId);

    try {
        if (failed) {
            logToPanel("Error: " + command + (resultObj.message ? " - " + resultObj.message : ""));
            statusText.text = "Error: " + command;
        } else {
            logToPanel("Done: " + command);
            statusText.text = "Command completed: " + command;
        }
    } catch (uiError) {}
}

// Rewrites the command file's status only while it still holds the command we processed.
function updateCommandStatus(status, commandId) {
    try {
        var commandFile = new File(getCommandFilePath());
        if (!commandFile.exists) return;
        commandFile.encoding = "UTF-8";
        if (!commandFile.open("r")) return;
        var content = commandFile.read();
        commandFile.close();
        if (!content) return;
        var commandData = JSON.parse(content);
        if (String(commandData.id || commandData.timestamp || "") !== commandId) return;
        commandData.status = status;
        if (!commandFile.open("w")) return;
        commandFile.write(JSON.stringify(commandData, null, 2));
        commandFile.close();
    } catch (e) {
        logToPanel("Error updating command status: " + e.toString());
    }
}


// Never throws: it is called from error paths that must still write a result.
function logToPanel(message) {
    try {
        var timestamp = new Date().toLocaleTimeString();
        var text = timestamp + ": " + message + "\n" + logText.text;
        if (text.length > 20000) text = text.substring(0, 20000);
        logText.text = text;
    } catch (e) {}
}


var lastCheckError = null;

function checkForCommands() {
    if (isChecking) return;
    isChecking = true;
    try {
        try { refreshSandboxUI(); } catch (uiError) {}
        var commandFile = new File(getCommandFilePath());
        if (commandFile.exists) {
            commandFile.encoding = "UTF-8";
            commandFile.open("r");
            var content = commandFile.read();
            commandFile.close();
            if (content) {
                var commandData = JSON.parse(content);
                var commandId = String(commandData.id || commandData.timestamp || "");
                if (commandData.status === "pending" && commandId !== lastProcessedId) {
                    lastProcessedId = commandId;
                    updateCommandStatus("running", commandId);
                    executeCommand(commandData);
                }
            }
        }
        lastCheckError = null;
    } catch (e) {
        var msg = e.toString();
        if (msg !== lastCheckError) logToPanel("Error checking for commands: " + msg);
        lastCheckError = msg;
    } finally {
        isChecking = false;
    }
}


// scheduleTask evaluates its string in global scope, so the poller is exported as $.global.__mcpBridgeCheck.
// Repeating tasks outlive their window, so a new instance cancels the previous one's task first;
// a task from an older panel that didn't record its id still calls the global, which now points here.
function startCommandChecker() {
    stopCommandChecker();
    $.global.__mcpBridgeCheck = checkForCommands;
    $.global.__mcpBridgeTaskId = app.scheduleTask("__mcpBridgeCheck()", checkInterval, true);
}

function stopCommandChecker() {
    if ($.global.__mcpBridgeTaskId) {
        try { app.cancelTask($.global.__mcpBridgeTaskId); } catch (e) {}
        $.global.__mcpBridgeTaskId = null;
    }
}


pauseCheckbox.onClick = function () {
    logToPanel(pauseCheckbox.value ? "Paused: Claude's commands will be refused." : "Resumed: Claude's commands are accepted.");
};

var checkButton = panel.add("button", undefined, "Check for Commands Now");
checkButton.onClick = function() {
    logToPanel("Manually checking for commands");
    checkForCommands();
};


logToPanel("MCP Bridge Auto started");
logToPanel("Command file: " + getCommandFilePath());
logToPanel("Result file: " + getResultFilePath());
refreshSandboxUI();
statusText.text = "Ready";


startCommandChecker();


if (isDocked) {
    panel.layout.layout(true);
    panel.layout.resize();
    panel.onResizing = panel.onResize = function () { this.layout.resize(); };
} else {
    // Closing the floating window stops polling; otherwise the task would keep running with no UI.
    panel.onClose = function () {
        if ($.global.__mcpBridgeCheck === checkForCommands) {
            stopCommandChecker();
            $.global.__mcpBridgeCheck = function () {};
        }
    };
    panel.onResizing = panel.onResize = function () { this.layout.resize(); };
    panel.center();
    panel.show();
}

})(this);

