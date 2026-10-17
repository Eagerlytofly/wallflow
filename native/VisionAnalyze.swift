// Vision analysis helper: one JSON array in, one JSON array out.
//
// Everything here runs on-device (Apple Vision). No photo ever leaves the
// Mac for the *selection* step; only the finalists go to Volcengine Ark for
// styling. That keeps curation free and private.

import AppKit
import Foundation
import Vision

struct Tag: Codable { let id: String; let confidence: Double }
struct Face: Codable {
    let x: Double; let y: Double; let w: Double; let h: Double
    let quality: Double?
}
struct Salient: Codable { let x: Double; let y: Double; let w: Double; let h: Double }
struct Aesthetic: Codable { let score: Double; let isUtility: Bool }
struct Out: Codable {
    let path: String
    let ok: Bool
    var error: String?
    let width: Int
    let height: Int
    let tags: [Tag]
    let animals: [Tag]
    let faces: [Face]
    let salient: [Salient]
    let aesthetic: Aesthetic?
    let textChars: Int
}

func analyze(_ path: String) -> Out {
    let empty = Out(path: path, ok: false, error: nil, width: 0, height: 0,
                     tags: [], animals: [], faces: [], salient: [], aesthetic: nil, textChars: 0)
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        var e = empty
        e.error = "decode_failed"
        return e
    }
    let w = cg.width
    let h = cg.height
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])

    let classify = VNClassifyImageRequest()
    let facesReq = VNDetectFaceRectanglesRequest()
    let qualityReq = VNDetectFaceCaptureQualityRequest()
    let saliencyReq = VNGenerateAttentionBasedSaliencyImageRequest()
    let textReq = VNRecognizeTextRequest()
    textReq.recognitionLevel = .fast
    textReq.usesLanguageCorrection = false

    // Core requests are the ones we cannot do without; run them together.
    do {
        try handler.perform([classify, facesReq, qualityReq, saliencyReq, textReq])
    } catch {
        var e = empty
        e.error = "vision_failed: \(error.localizedDescription)"
        return e
    }

    // Optional requests (availability differs by macOS version / hardware).
    let animalsReq = VNRecognizeAnimalsRequest()
    var animalLabels: [Tag] = []
    if (try? handler.perform([animalsReq])) != nil {
        animalLabels = (animalsReq.results ?? []).flatMap { obs in
            obs.labels.map { Tag(id: $0.identifier, confidence: Double($0.confidence)) }
        }
        animalLabels.sort { $0.confidence > $1.confidence }
        animalLabels = Array(animalLabels.prefix(4))
    }

    var aes: Aesthetic? = nil
    if #available(macOS 15.0, *) {
        let aesReq = VNCalculateImageAestheticsScoresRequest()
        if (try? handler.perform([aesReq])) != nil, let obs = aesReq.results?.first {
            aes = Aesthetic(score: Double(obs.overallScore), isUtility: obs.isUtility)
        }
    }

    var tags = (classify.results ?? []).prefix(12).map {
        Tag(id: $0.identifier, confidence: Double($0.confidence))
    }
    tags.sort { $0.confidence > $1.confidence }

    let qmap: [UUID: Double] = Dictionary(uniqueKeysWithValues: (qualityReq.results ?? []).compactMap { o in
        guard let q = o.faceCaptureQuality else { return nil }
        return (o.uuid, Double(q))
    })
    let faces: [Face] = (facesReq.results ?? []).map { f in
        Face(x: Double(f.boundingBox.origin.x), y: Double(f.boundingBox.origin.y),
             w: Double(f.boundingBox.width), h: Double(f.boundingBox.height),
             quality: qmap[f.uuid])
    }

    var salient: [Salient] = []
    if let obs = saliencyReq.results?.first, let objects = obs.salientObjects {
        salient = objects.map {
            Salient(x: Double($0.boundingBox.origin.x), y: Double($0.boundingBox.origin.y),
                    w: Double($0.boundingBox.width), h: Double($0.boundingBox.height))
        }
    }

    var textChars = 0
    for o in (textReq.results ?? []) {
        if let c = o.topCandidates(1).first { textChars += c.string.count }
    }

    return Out(path: path, ok: true, error: nil, width: w, height: h,
               tags: Array(tags), animals: animalLabels, faces: faces,
               salient: salient, aesthetic: aes, textChars: textChars)
}

let paths = Array(CommandLine.arguments.dropFirst())
var outs: [Out] = []
outs.reserveCapacity(paths.count)
for p in paths {
    outs.append(analyze(p))
}
let encoder = JSONEncoder()
if let data = try? encoder.encode(outs), let text = String(data: data, encoding: .utf8) {
    print(text)
} else {
    FileHandle.standardError.write("vision-analyze: failed to encode output\n".data(using: .utf8)!)
    exit(2)
}
